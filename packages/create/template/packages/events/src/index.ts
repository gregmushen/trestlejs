import { z } from "zod";

export * from "./catalog.js";
export * from "./application-catalog.js";

export const eventEnvelopeSchema = z.object({
  id: z.uuid(), name: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u), schemaVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime(), resource: z.object({ type: z.string().min(1), id: z.string().min(1) }),
  correlationId: z.string().min(1), causationId: z.string().min(1).optional(), idempotencyKey: z.string().min(1), payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type EventDefinition<T = unknown> = { name: string; schemaVersion: number; parse: (payload: unknown) => T };

/** Longest supported gap between commit and consumption: Queue retries, DLQ replay, and Workflow retries all complete inside it. */
export const EVENT_REPLAY_WINDOW_DAYS = 14;
/** Committed provenance is kept at least this long; pruning refuses newer cutoffs. */
export const EVENT_PROVENANCE_RETENTION_DAYS = 30;

export type PermanentEventReason = "provenance_missing" | "provenance_mismatch" | "provenance_expired" | "tenant_provenance_missing" | "not_entitled";
/** A message that must never reach its handler. It is logged with its reason and follows the existing dead-letter path; it is never acknowledged as handled. */
export class PermanentEventError extends Error {
  constructor(readonly reason: PermanentEventReason) { super(`Permanent event failure: ${reason}`); this.name = "PermanentEventError"; }
}

const safeErrorNames = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AbortError", "TimeoutError", "PermanentEventError"]);
export function safeErrorCategory(error: unknown): string {
  return error instanceof Error && safeErrorNames.has(error.name) ? error.name : "Error";
}

export class EventRegistry {
  private readonly definitions = new Map<string, EventDefinition>();
  register<T>(definition: EventDefinition<T>): void {
    const key = `${definition.name}@${definition.schemaVersion}`;
    if (this.definitions.has(key)) throw new Error(`Event definition ${key} is already registered`);
    this.definitions.set(key, definition);
  }
  parse<T>(envelope: EventEnvelope): T {
    const definition = this.definitions.get(`${envelope.name}@${envelope.schemaVersion}`);
    if (!definition) throw new Error(`No event definition registered for ${envelope.name}@${envelope.schemaVersion}`);
    return definition.parse(envelope.payload) as T;
  }
}

export type OutboxStatus = "pending" | "leased" | "succeeded" | "dead";
/** Organization provenance is committed metadata, never Queue payload authority. */
export type OutboxEntry = { id: string; message: EventEnvelope; organizationId?: string; status: OutboxStatus; attempts: number; availableAt: Date; leasedUntil?: Date; lastError?: string };
export type OutboxClock = { now(): Date };

export class InMemoryOutbox {
  private readonly entries = new Map<string, OutboxEntry>();
  constructor(private readonly clock: OutboxClock = { now: () => new Date() }) {}
  append(message: EventEnvelope, options: { organizationId?: string } = {}): OutboxEntry {
    if (options.organizationId !== undefined && !options.organizationId.trim()) throw new Error("Outbox organization ID must not be blank");
    const existing = [...this.entries.values()].find((entry) => entry.message.idempotencyKey === message.idempotencyKey);
    if (existing) {
      if (existing.organizationId !== options.organizationId) throw new Error("Outbox idempotency key belongs to a different organization");
      return existing;
    }
    const entry: OutboxEntry = { id: message.id, message, ...(options.organizationId ? { organizationId: options.organizationId } : {}), status: "pending", attempts: 0, availableAt: new Date(message.occurredAt) };
    this.entries.set(entry.id, entry); return entry;
  }
  lease(limit = 10, leaseMs = 30_000): OutboxEntry[] {
    const now = this.clock.now();
    for (const entry of this.entries.values()) if (entry.status === "leased" && entry.leasedUntil && entry.leasedUntil <= now) { entry.status = "pending"; delete entry.leasedUntil; }
    return [...this.entries.values()].filter((entry) => entry.status === "pending" && entry.availableAt <= now).sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime()).slice(0, limit).map((entry) => { entry.status = "leased"; entry.leasedUntil = new Date(now.getTime() + leaseMs); return entry; });
  }
  succeed(id: string): void { const entry = this.require(id); if (entry.status === "succeeded") return; if (entry.status !== "leased") throw new Error(`Outbox entry ${id} is not leased`); entry.status = "succeeded"; delete entry.leasedUntil; }
  fail(id: string, error: unknown, maxAttempts = 5): void {
    const entry = this.require(id); if (entry.status !== "leased") throw new Error(`Outbox entry ${id} is not leased`);
    entry.attempts += 1; entry.lastError = safeErrorCategory(error); delete entry.leasedUntil;
    if (entry.attempts >= maxAttempts) { entry.status = "dead"; return; }
    entry.status = "pending"; entry.availableAt = new Date(this.clock.now().getTime() + 2 ** (entry.attempts - 1) * 1_000);
  }
  redrive(id: string): OutboxEntry { const entry = this.require(id); if (entry.status !== "dead") throw new Error(`Outbox entry ${id} is not dead-lettered`); entry.status = "pending"; entry.availableAt = this.clock.now(); delete entry.lastError; return entry; }
  list(): OutboxEntry[] { return [...this.entries.values()].map((entry) => ({ ...entry, message: { ...entry.message } })); }
  private require(id: string): OutboxEntry { const entry = this.entries.get(id); if (!entry) throw new Error(`Outbox entry ${id} was not found`); return entry; }
}

export class InMemoryQueue {
  private readonly messages = new Map<string, EventEnvelope>();
  async send(message: EventEnvelope): Promise<boolean> { if (this.messages.has(message.idempotencyKey)) return false; this.messages.set(message.idempotencyKey, message); return true; }
  async drain(handler: (message: EventEnvelope) => Promise<void>): Promise<number> { let handled = 0; for (const [key, message] of [...this.messages]) { await handler(message); this.messages.delete(key); handled += 1; } return handled; }
  size(): number { return this.messages.size; }
}

export type WorkflowJob = { id: string; runAt: Date; message: EventEnvelope; status: "scheduled" | "running" | "succeeded" | "failed"; attempts: number; lastError?: string };
export class LocalWorkflowScheduler {
  private readonly jobs = new Map<string, WorkflowJob>();
  constructor(private readonly clock: OutboxClock = { now: () => new Date() }) {}
  schedule(message: EventEnvelope, runAt: Date): WorkflowJob { const existing = [...this.jobs.values()].find((job) => job.message.idempotencyKey === message.idempotencyKey); if (existing) return existing; const job = { id: message.id, runAt, message, status: "scheduled" as const, attempts: 0 }; this.jobs.set(job.id, job); return job; }
  async runDue(handler: (message: EventEnvelope) => Promise<void>, options: { maxAttempts?: number; retryDelayMs?: number } = {}): Promise<number> {
    const maxAttempts = options.maxAttempts ?? 5;
    const retryDelayMs = options.retryDelayMs ?? 1_000;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || !Number.isInteger(retryDelayMs) || retryDelayMs < 0) throw new Error("Invalid workflow retry policy");
    let completed = 0;
    for (const job of this.jobs.values()) {
      if (job.status !== "scheduled" || job.runAt > this.clock.now()) continue;
      job.status = "running";
      job.attempts += 1;
      try {
        await handler(job.message);
        job.status = "succeeded";
        completed += 1;
      } catch (error) {
        job.lastError = safeErrorCategory(error);
        if (job.attempts >= maxAttempts) job.status = "failed";
        else {
          job.status = "scheduled";
          job.runAt = new Date(this.clock.now().getTime() + 2 ** (job.attempts - 1) * retryDelayMs);
        }
      }
    }
    return completed;
  }
  list(): WorkflowJob[] { return [...this.jobs.values()].map((job) => ({ ...job, message: { ...job.message } })); }
}

export interface OutboxStore {
  append(message: EventEnvelope, options?: { organizationId?: string }): Promise<OutboxEntry>;
  lease(limit?: number, leaseMs?: number): Promise<OutboxEntry[]>;
  succeed(id: string): Promise<void>;
  fail(id: string, error: unknown, maxAttempts?: number): Promise<void>;
  listDead(): Promise<OutboxEntry[]>;
  redrive(id: string): Promise<OutboxEntry>;
}

export interface QueuePublisher { send(message: EventEnvelope): Promise<void> }

export async function dispatchOutbox(store: OutboxStore, publisher: QueuePublisher, options: { limit?: number; leaseMs?: number; maxAttempts?: number } = {}): Promise<{ sent: number; failed: number }> {
  const leased = await store.lease(options.limit, options.leaseMs);
  let sent = 0; let failed = 0;
  for (const entry of leased) {
    try { await publisher.send(entry.message); await store.succeed(entry.id); sent += 1; }
    catch (error) { await store.fail(entry.id, error, options.maxAttempts); failed += 1; }
  }
  return { sent, failed };
}

export type CloudflareQueueBinding<Message = EventEnvelope> = { send(body: Message, options?: { contentType?: "json" }): Promise<void> };
export class CloudflareQueuePublisher implements QueuePublisher {
  constructor(private readonly binding: CloudflareQueueBinding) {}
  async send(message: EventEnvelope): Promise<void> { await this.binding.send(eventEnvelopeSchema.parse(message), { contentType: "json" }); }
}

export type InboxClaim = { state: "claimed"; token: string } | { state: "completed" } | { state: "busy" };
export interface EventInboxStore {
  claim(message: EventEnvelope, leaseMs?: number): Promise<InboxClaim>;
  complete(idempotencyKey: string, token: string): Promise<void>;
  release(idempotencyKey: string, token: string, error: unknown): Promise<void>;
}

export class InMemoryEventInbox implements EventInboxStore {
  private readonly entries = new Map<string, { name: string; state: "processing" | "completed"; token?: string; leasedUntil?: Date }>();
  constructor(private readonly clock: OutboxClock = { now: () => new Date() }) {}
  async claim(message: EventEnvelope, leaseMs = 120_000): Promise<InboxClaim> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new Error("Inbox lease must be between 1 and 300000 milliseconds");
    const existing = this.entries.get(message.idempotencyKey);
    if (existing?.name && existing.name !== message.name) throw new Error("Inbox idempotency key belongs to a different event");
    if (existing?.state === "completed") return { state: "completed" };
    if (existing?.token && existing.leasedUntil && existing.leasedUntil > this.clock.now()) return { state: "busy" };
    const token = crypto.randomUUID();
    this.entries.set(message.idempotencyKey, { name: message.name, state: "processing", token, leasedUntil: new Date(this.clock.now().getTime() + leaseMs) });
    return { state: "claimed", token };
  }
  async complete(idempotencyKey: string, token: string): Promise<void> {
    const entry = this.entries.get(idempotencyKey);
    if (!entry || entry.state !== "processing" || entry.token !== token) throw new Error("Inbox claim is no longer active");
    this.entries.set(idempotencyKey, { name: entry.name, state: "completed" });
  }
  async release(idempotencyKey: string, token: string, _error: unknown): Promise<void> {
    const entry = this.entries.get(idempotencyKey);
    if (!entry || entry.state !== "processing" || entry.token !== token) throw new Error("Inbox claim is no longer active");
    this.entries.set(idempotencyKey, { name: entry.name, state: "processing" });
  }
}

export type QueueBatchMessage = { body: unknown; ack(): void; retry(options?: { delaySeconds?: number }): void };
export type QueueSettlement = Readonly<{ outcome: "acknowledged" | "retried"; event?: Readonly<Pick<EventEnvelope, "id" | "name" | "schemaVersion" | "correlationId" | "causationId">> }>;
export async function processQueueBatch(messages: QueueBatchMessage[], handler: (message: EventEnvelope) => Promise<void>, retryDelaySeconds = 30, observe?: (settlement: QueueSettlement) => void): Promise<{ acknowledged: number; retried: number }> {
  let acknowledged = 0; let retried = 0;
  for (const item of messages) {
    let envelope: EventEnvelope | undefined;
    let outcome: QueueSettlement["outcome"];
    try { envelope = eventEnvelopeSchema.parse(item.body); await handler(envelope); item.ack(); acknowledged += 1; outcome = "acknowledged"; }
    catch { item.retry({ delaySeconds: retryDelaySeconds }); retried += 1; outcome = "retried"; }
    // Diagnostics cannot change Queue acknowledgment, retry, or tenant authority.
    try { observe?.({ outcome, ...(envelope ? { event: { id: envelope.id, name: envelope.name, schemaVersion: envelope.schemaVersion, correlationId: envelope.correlationId, ...(envelope.causationId ? { causationId: envelope.causationId } : {}) } } : {}) }); } catch { /* Best effort. */ }
  }
  return { acknowledged, retried };
}
