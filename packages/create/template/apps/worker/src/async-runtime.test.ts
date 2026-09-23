import { eventEnvelopeSchema, InMemoryEventInbox } from "@__TRESTLE_PROJECT_NAME__/events";
import { describe, expect, it } from "vitest";

import { createQueueConsumer, EventConsumerRegistry } from "./async-runtime.js";

const envelope = () => eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "article.published", schemaVersion: 1, occurredAt: new Date().toISOString(), resource: { type: "article", id: "article-1" }, correlationId: "correlation-1", idempotencyKey: "article-1:published", payload: { title: "Hello" } });

describe("Worker Queue consumer", () => {
  it("validates, dispatches, preserves correlation, and acknowledges a registered versioned event", async () => { const handled: string[] = []; const registry = new EventConsumerRegistry<{ marker: string }>(); registry.register({ name: "article.published", schemaVersion: 1, parse: (payload) => payload as { title: string } }, async (payload, event, environment) => { handled.push(`${environment.marker}:${payload.title}:${event.correlationId}`); }); const states: string[] = []; const result = await createQueueConsumer(registry, new InMemoryEventInbox())({ messages: [{ body: envelope(), ack: () => states.push("ack"), retry: () => states.push("retry") }] }, { marker: "worker" }); expect(result).toEqual({ acknowledged: 1, retried: 0 }); expect(states).toEqual(["ack"]); expect(handled).toEqual(["worker:Hello:correlation-1"]); });
  it("retries unknown and invalid messages", async () => { const registry = new EventConsumerRegistry(); const states: string[] = []; const result = await createQueueConsumer(registry, new InMemoryEventInbox())({ messages: [{ body: envelope(), ack: () => states.push("ack"), retry: () => states.push("retry") }, { body: {}, ack: () => states.push("ack"), retry: () => states.push("retry") }] }, {}); expect(result).toEqual({ acknowledged: 0, retried: 2 }); expect(states).toEqual(["retry", "retry"]); });
  it("skips completed duplicate logical events and retries transient handler failures", async () => {
    const registry = new EventConsumerRegistry();
    const inbox = new InMemoryEventInbox();
    let attempts = 0;
    registry.register({ name: "article.published", schemaVersion: 1, parse: (payload) => payload }, async () => { attempts += 1; if (attempts === 1) throw new Error("temporary"); });
    const consumer = createQueueConsumer(registry, inbox);
    const event = envelope();
    const states: string[] = [];
    const batch = { messages: [{ body: event, ack: () => states.push("ack"), retry: () => states.push("retry") }] };
    expect(await consumer(batch, {})).toEqual({ acknowledged: 0, retried: 1 });
    expect(await consumer(batch, {})).toEqual({ acknowledged: 1, retried: 0 });
    expect(await consumer(batch, {})).toEqual({ acknowledged: 1, retried: 0 });
    expect(attempts).toBe(2);
    expect(states).toEqual(["retry", "ack", "ack"]);
  });
  it("rejects duplicate consumer registrations", () => { const registry = new EventConsumerRegistry(); const definition = { name: "article.published", schemaVersion: 1, parse: (payload: unknown) => payload }; registry.register(definition, async () => undefined); expect(() => registry.register(definition, async () => undefined)).toThrow("already registered"); });
});
