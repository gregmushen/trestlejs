import { z } from "zod";

export const eventEnvelopeSchema = z.object({
  id: z.uuid(), name: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/u), schemaVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime(), resource: z.object({ type: z.string().min(1), id: z.string().min(1) }),
  correlationId: z.string().min(1), causationId: z.string().min(1).optional(), idempotencyKey: z.string().min(1), payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type EventDefinition<T = unknown> = { name: string; schemaVersion: number; parse: (payload: unknown) => T };

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
export type OutboxEntry = { id: string; message: EventEnvelope; status: OutboxStatus; attempts: number; availableAt: Date; leasedUntil?: Date; lastError?: string };
export type OutboxClock = { now(): Date };

export class InMemoryOutbox {
  private readonly entries = new Map<string, OutboxEntry>();
  constructor(private readonly clock: OutboxClock = { now: () => new Date() }) {}
  append(message: EventEnvelope): OutboxEntry {
    const existing = [...this.entries.values()].find((entry) => entry.message.idempotencyKey === message.idempotencyKey);
    if (existing) return existing;
    const entry: OutboxEntry = { id: message.id, message, status: "pending", attempts: 0, availableAt: new Date(message.occurredAt) };
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
    entry.attempts += 1; entry.lastError = error instanceof Error ? error.message : String(error); delete entry.leasedUntil;
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
  async runDue(handler: (message: EventEnvelope) => Promise<void>): Promise<number> { let completed = 0; for (const job of this.jobs.values()) { if (job.status !== "scheduled" || job.runAt > this.clock.now()) continue; job.status = "running"; job.attempts += 1; try { await handler(job.message); job.status = "succeeded"; completed += 1; } catch (error) { job.status = "failed"; job.lastError = error instanceof Error ? error.message : String(error); } } return completed; }
  list(): WorkflowJob[] { return [...this.jobs.values()].map((job) => ({ ...job, message: { ...job.message } })); }
}
