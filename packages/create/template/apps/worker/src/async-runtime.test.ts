import { eventEnvelopeSchema } from "@__TRESTLE_PROJECT_NAME__/events";
import { describe, expect, it } from "vitest";

import { createQueueConsumer, EventConsumerRegistry } from "./async-runtime.js";

const envelope = () => eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "article.published", schemaVersion: 1, occurredAt: new Date().toISOString(), resource: { type: "article", id: "article-1" }, correlationId: "correlation-1", idempotencyKey: "article-1:published", payload: { title: "Hello" } });

describe("Worker Queue consumer", () => {
  it("validates, dispatches, preserves correlation, and acknowledges a registered versioned event", async () => { const handled: string[] = []; const registry = new EventConsumerRegistry<{ marker: string }>(); registry.register({ name: "article.published", schemaVersion: 1, parse: (payload) => payload as { title: string } }, async (payload, event, environment) => { handled.push(`${environment.marker}:${payload.title}:${event.correlationId}`); }); const states: string[] = []; const result = await createQueueConsumer(registry)({ messages: [{ body: envelope(), ack: () => states.push("ack"), retry: () => states.push("retry") }] }, { marker: "worker" }); expect(result).toEqual({ acknowledged: 1, retried: 0 }); expect(states).toEqual(["ack"]); expect(handled).toEqual(["worker:Hello:correlation-1"]); });
  it("retries unknown and invalid messages", async () => { const registry = new EventConsumerRegistry(); const states: string[] = []; const result = await createQueueConsumer(registry)({ messages: [{ body: envelope(), ack: () => states.push("ack"), retry: () => states.push("retry") }, { body: {}, ack: () => states.push("ack"), retry: () => states.push("retry") }] }, {}); expect(result).toEqual({ acknowledged: 0, retried: 2 }); expect(states).toEqual(["retry", "retry"]); });
  it("rejects duplicate consumer registrations", () => { const registry = new EventConsumerRegistry(); const definition = { name: "article.published", schemaVersion: 1, parse: (payload: unknown) => payload }; registry.register(definition, async () => undefined); expect(() => registry.register(definition, async () => undefined)).toThrow("already registered"); });
});
