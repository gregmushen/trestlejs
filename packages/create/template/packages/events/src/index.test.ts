import { describe, expect, it } from "vitest";
import { CloudflareQueuePublisher, EventRegistry, InMemoryOutbox, InMemoryQueue, LocalWorkflowScheduler, dispatchOutbox, eventEnvelopeSchema, processQueueBatch, type OutboxStore, type QueueBatchMessage } from "./index.js";

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
  it("retries failed workflows deterministically", async () => { const retryClock = { current: now, now() { return this.current; } }; const scheduler = new LocalWorkflowScheduler(retryClock); scheduler.schedule(message("workflow-retry"), now); let calls = 0; expect(await scheduler.runDue(async () => { calls += 1; throw new Error("temporary"); }, { retryDelayMs: 1_000 })).toBe(0); expect(scheduler.list()[0]).toMatchObject({ status: "scheduled", attempts: 1, lastError: "Error" }); expect(await scheduler.runDue(async () => undefined)).toBe(0); retryClock.current = new Date(now.getTime() + 1_000); expect(await scheduler.runDue(async () => undefined)).toBe(1); expect(calls).toBe(1); });
  it("does not rerun terminal failures or persist sensitive error messages", async () => {
    const retryClock = { current: now, now() { return this.current; } };
    const scheduler = new LocalWorkflowScheduler(retryClock);
    scheduler.schedule(message("workflow-terminal"), now);
    let calls = 0;
    await scheduler.runDue(async () => { calls += 1; throw new Error("sk_sensitive-provider-key"); }, { maxAttempts: 1 });
    expect(scheduler.list()[0]).toMatchObject({ status: "failed", attempts: 1, lastError: "Error" });
    retryClock.current = new Date(now.getTime() + 86_400_000);
    expect(await scheduler.runDue(async () => { calls += 1; })).toBe(0);
    expect(calls).toBe(1);
    expect(JSON.stringify(scheduler.list())).not.toContain("sk_sensitive-provider-key");
  });
  it("dispatches leased outbox messages and records publisher failures", async () => {
    const leased = [{ ...new InMemoryOutbox(clock).append(message("dispatch-1")), status: "leased" as const }]; const succeeded: string[] = []; const failed: string[] = [];
    const store = { lease: async () => leased, succeed: async (id: string) => { succeeded.push(id); }, fail: async (id: string) => { failed.push(id); } } as unknown as OutboxStore;
    expect(await dispatchOutbox(store, { send: async () => undefined })).toEqual({ sent: 1, failed: 0 }); expect(succeeded).toEqual([leased[0]!.id]); expect(failed).toEqual([]);
    expect(await dispatchOutbox(store, { send: async () => { throw new Error("offline"); } })).toEqual({ sent: 0, failed: 1 }); expect(failed).toEqual([leased[0]!.id]);
  });
  it("adapts Cloudflare Queue JSON delivery and retries failed batch items", async () => {
    const sent: unknown[] = []; const publisher = new CloudflareQueuePublisher({ send: async (body, options) => { sent.push(body, options); } }); await publisher.send(message("cloudflare-1")); expect(sent[1]).toEqual({ contentType: "json" });
    const states: string[] = []; const batch: QueueBatchMessage[] = [
      { body: message("batch-1"), ack: () => states.push("ack"), retry: () => states.push("unexpected") },
      { body: { invalid: true }, ack: () => states.push("unexpected"), retry: ({ delaySeconds } = {}) => states.push(`retry:${delaySeconds}`) },
    ];
    expect(await processQueueBatch(batch, async () => undefined, 17)).toEqual({ acknowledged: 1, retried: 1 }); expect(states).toEqual(["ack", "retry:17"]);
  });
});
