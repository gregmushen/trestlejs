import { createLogger, loggerSecretsFromEnvironment, type Logger } from "@__TRESTLE_PROJECT_NAME__/context";
import { verifyCommittedEvent, type CommittedEventStore } from "@__TRESTLE_PROJECT_NAME__/db";
import { CloudflareQueuePublisher, dispatchOutbox, EventRegistry, PermanentEventError, processQueueBatch, type CloudflareQueueBinding, type EventDefinition, type EventEnvelope, type EventInboxStore, type OutboxEntry, type OutboxStore, type QueueBatchMessage, type QueueSettlement } from "@__TRESTLE_PROJECT_NAME__/events";
import type { defineEventCatalog } from "@__TRESTLE_PROJECT_NAME__/events";

export type QueueBatch = { messages: QueueBatchMessage[] };

/**
 * What a handler may do with a verified event.
 * - `verified` (the undeclared default): the committed event and its organization, but no database.
 * - `tenant`: adds `data`, a database scoped to the committed organization.
 * - `system`: non-tenant work; no organization is required and no `data` is given.
 */
export type EventAuthority = "verified" | "tenant" | "system";
export type EventHandlerContext<Data = unknown> = Readonly<{
  /** The committed event; identical to the delivered envelope after verification. */
  event: EventEnvelope;
  authority: EventAuthority;
  /** From the committed outbox row; present for "verified" and "tenant". */
  organizationId?: string;
  /** Only for "tenant": created lazily on first access, scoped to organizationId under forced RLS. */
  readonly data?: Data;
  /** Correlated, secret-redacting logger. */
  log: Logger;
  /** Injectable; tests pass a fixed clock. */
  clock: { now(): Date };
}>;
export type EventHandler<T = unknown, Environment = unknown, Data = unknown> =
  (payload: T, envelope: EventEnvelope, environment: Environment, context: EventHandlerContext<Data>) => Promise<void>;
export type EventRegistration = { authority?: "tenant" | "system"; requires?: { entitlement: string } };
/** Post-commit work (webhook projection) receives the verified committed row so it need not query again. */
export type PostCommitEffect<Environment> = (envelope: EventEnvelope, environment: Environment, committed?: OutboxEntry) => Promise<void>;
export type EventConsumerDependencies<Environment, Data> = {
  /** Opens tenant-scoped data for `{ authority: "tenant" }` handlers. */
  tenantData?: (environment: Environment, organizationId: string) => Data;
  /** Reads the tenant's current entitlements for `{ requires: { entitlement } }` registrations. */
  hasEntitlement?: (environment: Environment, organizationId: string, entitlement: string) => Promise<boolean>;
  clock?: { now(): Date };
  logger?: (fields: Record<string, unknown>, environment: Environment) => Logger;
};
type EventCatalog = ReturnType<typeof defineEventCatalog>;
type Registered<Environment, Data> = { handler: EventHandler<unknown, Environment, Data>; authority: EventAuthority; requires?: { entitlement: string } };

const systemClock = { now: () => new Date() };

export class EventConsumerRegistry<Environment = unknown, Data = unknown> {
  private readonly definitions = new EventRegistry();
  private readonly handlers = new Map<string, Registered<Environment, Data>>();
  readonly clock: { now(): Date };
  constructor(private readonly catalog?: EventCatalog, private readonly dependencies: EventConsumerDependencies<Environment, Data> = {}) {
    this.clock = dependencies.clock ?? systemClock;
  }

  register<T>(definition: EventDefinition<T>, handler: EventHandler<T, Environment, Data>, registration: EventRegistration = {}): void {
    const key = `${definition.name}@${definition.schemaVersion}`;
    if (this.handlers.has(key)) throw new Error(`Event consumer ${key} is already registered`);
    if (registration.authority === "tenant" && !this.dependencies.tenantData) throw new Error(`Event consumer ${key} needs tenant data, but the registry has no tenant data factory`);
    if (registration.requires && !this.dependencies.hasEntitlement) throw new Error(`Event consumer ${key} requires an entitlement, but the registry has no entitlement check`);
    this.definitions.register(definition);
    this.handlers.set(key, {
      handler: handler as EventHandler<unknown, Environment, Data>,
      authority: registration.authority ?? "verified",
      ...(registration.requires ? { requires: registration.requires } : {}),
    });
  }

  validate(envelope: EventEnvelope): void {
    const key = `${envelope.name}@${envelope.schemaVersion}`;
    if (!this.handlers.has(key) && !this.catalog?.has(envelope.name, envelope.schemaVersion)) throw new Error(`No event consumer registered for ${key}`);
    if (this.catalog?.has(envelope.name, envelope.schemaVersion)) {
      this.catalog.parse(envelope.name, envelope.schemaVersion, envelope.payload);
      const resource = this.catalog.resource(envelope.name, envelope.schemaVersion, envelope.payload);
      if (resource.type !== envelope.resource.type || resource.id !== envelope.resource.id) throw new Error(`Event resource differs from catalog definition for ${key}`);
    }
    if (this.handlers.has(key)) this.definitions.parse(envelope);
  }

  /** Reload and compare the committed row, checking its age against this registry's clock. */
  async verify(outbox: CommittedEventStore, envelope: EventEnvelope): Promise<OutboxEntry> {
    return await verifyCommittedEvent(outbox, envelope, { now: this.clock.now() });
  }

  /**
   * Resolve the declared authority for a verified committed event, checking
   * organization provenance. Missing provenance never widens access: it is a
   * permanent rejection. Entitlement is checked separately by `entitled`.
   */
  async authorize(committed: OutboxEntry, environment: Environment): Promise<EventHandlerContext<Data>> {
    const event = committed.message;
    const registered = this.handlers.get(`${event.name}@${event.schemaVersion}`);
    const authority = registered?.authority ?? "verified";
    const organizationId = committed.organizationId;
    if ((authority !== "system" || registered?.requires) && !organizationId) throw new PermanentEventError("tenant_provenance_missing");
    const fields = { correlationId: event.correlationId, ...(event.causationId ? { causationId: event.causationId } : {}), eventId: event.id, eventName: event.name, ...(authority !== "system" && organizationId ? { organizationId } : {}) };
    const log = this.dependencies.logger?.(fields, environment)
      ?? createLogger(fields, undefined, { secretValues: loggerSecretsFromEnvironment((environment ?? {}) as object) });
    const context = { event, authority, log, clock: this.clock } as { event: EventEnvelope; authority: EventAuthority; organizationId?: string; data?: Data; log: Logger; clock: { now(): Date } };
    if (authority !== "system") context.organizationId = organizationId!;
    if (authority === "tenant") {
      // Tenant databases open a pool per call, so create one only if the handler reads it.
      // Not enumerable, so logging or inspecting the context never opens one.
      const tenantData = this.dependencies.tenantData!;
      let data: { value: Data } | undefined;
      Object.defineProperty(context, "data", { enumerable: false, get: () => (data ??= { value: tenantData(environment, organizationId!) }).value });
    }
    return Object.freeze(context);
  }

  /**
   * Whether the tenant currently holds the handler's required entitlement,
   * read from current state on every call. Only meaningful after `authorize`,
   * which guarantees organization provenance for such registrations.
   */
  async entitled(committed: OutboxEntry, environment: Environment): Promise<boolean> {
    const requires = this.handlers.get(`${committed.message.name}@${committed.message.schemaVersion}`)?.requires;
    return !requires || await this.dependencies.hasEntitlement!(environment, committed.organizationId!, requires.entitlement);
  }

  async handle(envelope: EventEnvelope, environment: Environment, context: EventHandlerContext<Data>): Promise<void> {
    const key = `${envelope.name}@${envelope.schemaVersion}`;
    const registered = this.handlers.get(key);
    if (registered) await registered.handler(this.definitions.parse(envelope), envelope, environment, context);
    else if (!this.catalog?.has(envelope.name, envelope.schemaVersion)) throw new Error(`No event consumer registered for ${key}`);
  }
}

export type CloudflareWorkflowBinding = {
  create(options: { id: string; params: EventEnvelope }): Promise<{ id: string }>;
  get(id: string): Promise<unknown>;
};

/**
 * Run one delivery of a committed event. The delivered envelope is only a
 * reference: it is verified against the committed outbox row, authorized from
 * that row, and only then claimed and handled. Everything after verification
 * sees the committed envelope. A `PermanentEventError` before the claim leaves
 * no inbox row; the caller routes it to the dead-letter path.
 *
 * A handler whose required entitlement the tenant currently lacks is skipped,
 * not rejected: post-commit work still runs and the inbox claim completes.
 */
export async function handleEventWithInbox<Environment, Data = unknown>(registry: EventConsumerRegistry<Environment, Data>, inbox: EventInboxStore, outbox: CommittedEventStore, envelope: EventEnvelope, environment: Environment, postCommit?: PostCommitEffect<Environment>): Promise<void> {
  registry.validate(envelope);
  const committed = await registry.verify(outbox, envelope);
  const context = await registry.authorize(committed, environment);
  const event = committed.message;
  const claim = await inbox.claim(event);
  if (claim.state === "completed") return;
  if (claim.state === "busy") throw new Error("Inbox event is already being processed");
  try {
    if (postCommit) await postCommit(event, environment, committed);
    if (await registry.entitled(committed, environment)) await registry.handle(event, environment, context);
    else context.log.warn("event.handler.skipped", { eventId: event.id, eventName: event.name, reason: "not_entitled" });
    await inbox.complete(event.idempotencyKey, claim.token);
  } catch (error) {
    await inbox.release(event.idempotencyKey, claim.token, error);
    throw error;
  }
}

export function createQueueConsumer<Environment, Data = unknown>(registry: EventConsumerRegistry<Environment, Data>, inbox: EventInboxStore, outbox: CommittedEventStore, postCommit?: PostCommitEffect<Environment>, observe?: (settlement: QueueSettlement) => void) {
  return async (batch: QueueBatch, environment: Environment): Promise<{ acknowledged: number; retried: number }> =>
    await processQueueBatch(batch.messages, async (envelope) => await handleEventWithInbox(registry, inbox, outbox, envelope, environment, postCommit), 30, observe);
}

/**
 * Hand a verified Queue event to one Workflow instance per event ID.
 * Verification happens before `create`, so a forged message can never claim
 * the stable instance ID, and the instance starts from the committed event.
 */
export function createWorkflowQueueConsumer<Environment, Data = unknown>(registry: EventConsumerRegistry<Environment, Data>, binding: CloudflareWorkflowBinding, outbox: CommittedEventStore, observe?: (settlement: QueueSettlement) => void) {
  return async (batch: QueueBatch): Promise<{ acknowledged: number; retried: number }> =>
    await processQueueBatch(batch.messages, async (envelope) => {
      registry.validate(envelope);
      const committed = await registry.verify(outbox, envelope);
      try {
        await binding.create({ id: committed.id, params: committed.message });
      } catch (error) {
        // A Queue delivery can be repeated after Workflow creation succeeds.
        // Only an existing instance with the same stable ID is safe to acknowledge.
        try { if (!await binding.get(committed.id)) throw error; }
        catch { throw error; }
      }
    }, 30, observe);
}

export async function dispatchQueuedOutbox(store: OutboxStore, binding: CloudflareQueueBinding): Promise<{ sent: number; failed: number }> {
  return await dispatchOutbox(store, new CloudflareQueuePublisher(binding));
}
