import { describe, expect, it } from "vitest";
import { EventRegistry, InMemoryOutbox, InMemoryQueue, LocalWorkflowScheduler, eventEnvelopeSchema } from "./index.js";

const now = new Date("2026-09-21T00:00:00.000Z");
const clock = { current: now, now() { return this.current; } };
const message = (key: string) => eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "article.published", schemaVersion: 1, occurredAt: now.toISOString(), resource: { type: "article", id: "article-1" }, correlationId: "corr-1", idempotencyKey: key, payload: { title: "Hello" } });

describe("Alpha 8 asynchronous execution spine", () => {
  it("requires versioned event definitions and rejects duplicate registrations", () => {
    const registry = new EventRegistry(); registry.register({ name: "article.published", schemaVersion: 1, parse: (payload) => payload as { title: string } });
    expect(registry.parse<{ title: string }>(message("event-1")).title).toBe("Hello");
    expect(() => registry.register({ name: "article.published", schemaVersion: 1, parse: () => null })).toThrow("already registered");
    expect(() => registry.parse({ ...message("event-2"), schemaVersion: 2 })).toThrow("No event definition");
  });
  it("deduplicates outbox appends and recovers expired leases", () => { const outbox = new InMemoryOutbox(clock); const first = outbox.append(message("outbox-1")); expect(outbox.append({ ...first.message, id: crypto.randomUUID() })).toBe(first); expect(outbox.lease(1, 100)).toHaveLength(1); clock.current = new Date(now.getTime() + 101); expect(outbox.lease()).toHaveLength(1); });
  it("backs off failures, dead-letters after the limit, and redrives explicitly", () => { const outbox = new InMemoryOutbox(clock); const entry = outbox.append(message("outbox-2")); for (let attempt = 1; attempt <= 3; attempt += 1) { outbox.lease(); outbox.fail(entry.id, new Error(`failure-${attempt}`), 3); clock.current = new Date(clock.current.getTime() + 2 ** (attempt - 1) * 1_000); } expect(outbox.list()[0]).toMatchObject({ status: "dead", attempts: 3, lastError: "failure-3" }); expect(outbox.redrive(entry.id).status).toBe("pending"); });
  it("delivers each queue idempotency key once", async () => { const queue = new InMemoryQueue(); expect(await queue.send(message("queue-1"))).toBe(true); expect(await queue.send(message("queue-1"))).toBe(false); const handled: string[] = []; expect(await queue.drain(async (event) => { handled.push(event.idempotencyKey); })).toBe(1); expect(handled).toEqual(["queue-1"]); });
  it("does not run scheduled workflows before their deterministic clock time", async () => { const scheduler = new LocalWorkflowScheduler(clock); const job = scheduler.schedule(message("workflow-1"), new Date(now.getTime() + 60_000)); expect(await scheduler.runDue(async () => undefined)).toBe(0); clock.current = new Date(now.getTime() + 60_000); expect(await scheduler.runDue(async (event) => { expect(event.idempotencyKey).toBe("workflow-1"); })).toBe(1); expect(scheduler.list()[0]).toMatchObject({ id: job.id, status: "succeeded", attempts: 1 }); });
});
