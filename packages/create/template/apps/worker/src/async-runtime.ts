import { CloudflareQueuePublisher, dispatchOutbox, EventRegistry, processQueueBatch, type CloudflareQueueBinding, type EventDefinition, type EventEnvelope, type EventInboxStore, type OutboxStore, type QueueBatchMessage } from "@__TRESTLE_PROJECT_NAME__/events";
import type { defineEventCatalog } from "@__TRESTLE_PROJECT_NAME__/events";

export type QueueBatch = { messages: QueueBatchMessage[] };
export type EventHandler<T = unknown, Environment = unknown> = (payload: T, envelope: EventEnvelope, environment: Environment) => Promise<void>;
export type PostCommitEffect<Environment> = (envelope: EventEnvelope, environment: Environment) => Promise<void>;
type EventCatalog = ReturnType<typeof defineEventCatalog>;

export class EventConsumerRegistry<Environment = unknown> {
  private readonly definitions = new EventRegistry();
  private readonly handlers = new Map<string, EventHandler<unknown, Environment>>();
  constructor(private readonly catalog?: EventCatalog) {}

  register<T>(definition: EventDefinition<T>, handler: EventHandler<T, Environment>): void {
    const key = `${definition.name}@${definition.schemaVersion}`;
    if (this.handlers.has(key)) throw new Error(`Event consumer ${key} is already registered`);
    this.definitions.register(definition);
    this.handlers.set(key, handler as EventHandler<unknown, Environment>);
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

  async handle(envelope: EventEnvelope, environment: Environment): Promise<void> {
    const key = `${envelope.name}@${envelope.schemaVersion}`;
    const handler = this.handlers.get(key);
    if (handler) await handler(this.definitions.parse(envelope), envelope, environment);
    else if (!this.catalog?.has(envelope.name, envelope.schemaVersion)) throw new Error(`No event consumer registered for ${key}`);
  }
}

export type CloudflareWorkflowBinding = {
  create(options: { id: string; params: EventEnvelope }): Promise<{ id: string }>;
  get(id: string): Promise<unknown>;
};

export async function handleEventWithInbox<Environment>(registry: EventConsumerRegistry<Environment>, inbox: EventInboxStore, envelope: EventEnvelope, environment: Environment, postCommit?: PostCommitEffect<Environment>): Promise<void> {
  registry.validate(envelope);
  const claim = await inbox.claim(envelope);
  if (claim.state === "completed") return;
  if (claim.state === "busy") throw new Error("Inbox event is already being processed");
  try {
    if (postCommit) await postCommit(envelope, environment);
    await registry.handle(envelope, environment);
    await inbox.complete(envelope.idempotencyKey, claim.token);
  } catch (error) {
    await inbox.release(envelope.idempotencyKey, claim.token, error);
    throw error;
  }
}

export function createQueueConsumer<Environment>(registry: EventConsumerRegistry<Environment>, inbox: EventInboxStore, postCommit?: PostCommitEffect<Environment>) {
  return async (batch: QueueBatch, environment: Environment): Promise<{ acknowledged: number; retried: number }> =>
    await processQueueBatch(batch.messages, async (envelope) => await handleEventWithInbox(registry, inbox, envelope, environment, postCommit));
}

export function createWorkflowQueueConsumer<Environment>(registry: EventConsumerRegistry<Environment>, binding: CloudflareWorkflowBinding) {
  return async (batch: QueueBatch): Promise<{ acknowledged: number; retried: number }> =>
    await processQueueBatch(batch.messages, async (envelope) => {
      registry.validate(envelope);
      try {
        await binding.create({ id: envelope.id, params: envelope });
      } catch (error) {
        // A Queue delivery can be repeated after Workflow creation succeeds.
        // Only an existing instance with the same stable ID is safe to acknowledge.
        try { if (!await binding.get(envelope.id)) throw error; }
        catch { throw error; }
      }
    });
}

export async function dispatchQueuedOutbox(store: OutboxStore, binding: CloudflareQueueBinding): Promise<{ sent: number; failed: number }> {
  return await dispatchOutbox(store, new CloudflareQueuePublisher(binding));
}
