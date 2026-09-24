import { applicationEventCatalog, defineEvent, defineEventCatalog, eventEnvelopeSchema, InMemoryEventInbox, LocalWorkflowScheduler } from "@__TRESTLE_PROJECT_NAME__/events";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createQueueConsumer, createWorkflowQueueConsumer, EventConsumerRegistry, handleEventWithInbox } from "./async-runtime.js";

const envelope = () => eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "article.published", schemaVersion: 1, occurredAt: new Date().toISOString(), resource: { type: "article", id: "article-1" }, correlationId: "correlation-1", idempotencyKey: "article-1:published", payload: { title: "Hello" } });

describe("Worker Queue consumer", () => {
  it("validates, dispatches, preserves correlation, and acknowledges a registered versioned event", async () => { const handled: string[] = []; const registry = new EventConsumerRegistry<{ marker: string }>(); registry.register({ name: "article.published", schemaVersion: 1, parse: (payload) => payload as { title: string } }, async (payload, event, environment) => { handled.push(`${environment.marker}:${payload.title}:${event.correlationId}`); }); const states: string[] = []; const result = await createQueueConsumer(registry, new InMemoryEventInbox())({ messages: [{ body: envelope(), ack: () => states.push("ack"), retry: () => states.push("retry") }] }, { marker: "worker" }); expect(result).toEqual({ acknowledged: 1, retried: 0 }); expect(states).toEqual(["ack"]); expect(handled).toEqual(["worker:Hello:correlation-1"]); });
  it("retries unknown and invalid messages", async () => { const registry = new EventConsumerRegistry(); const states: string[] = []; const result = await createQueueConsumer(registry, new InMemoryEventInbox())({ messages: [{ body: envelope(), ack: () => states.push("ack"), retry: () => states.push("retry") }, { body: {}, ack: () => states.push("ack"), retry: () => states.push("retry") }] }, {}); expect(result).toEqual({ acknowledged: 0, retried: 2 }); expect(states).toEqual(["retry", "retry"]); });
  it("acknowledges internal billing events without publishing a customer webhook", async () => {
    const payload = { organizationId: "org-billing", plan: "pro", planVersion: 1, status: "active",
      entitlements: ["article.basic"], cancelAtPeriodEnd: false };
    const event = eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "billing.subscription.activated", schemaVersion: 1,
      occurredAt: new Date().toISOString(), resource: { type: "organization", id: payload.organizationId },
      correlationId: "billing-correlation", idempotencyKey: "billing:stripe:evt_one", payload });
    const states: string[] = [];
    const consumer = createQueueConsumer(new EventConsumerRegistry(applicationEventCatalog), new InMemoryEventInbox(),
      async (message) => { expect(applicationEventCatalog.project(message.name, message.schemaVersion, message.payload)).toBeNull(); });
    expect(await consumer({ messages: [{ body: event, ack: () => states.push("ack"), retry: () => states.push("retry") }] }, {}))
      .toEqual({ acknowledged: 1, retried: 0 });
    expect(states).toEqual(["ack"]);
  });
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

  it("processes catalog-declared events without a bespoke consumer and keeps projection inside the inbox retry boundary", async () => {
    const catalog = defineEventCatalog([defineEvent({
      name: "article.published", schemaVersion: 1, description: "Article published", sensitivity: "internal",
      resource: { type: "article", id: (payload: { title: string }) => payload.title }, payload: z.object({ title: z.string() }),
    })]);
    const registry = new EventConsumerRegistry(catalog);
    const inbox = new InMemoryEventInbox();
    const event = { ...envelope(), resource: { type: "article", id: "Hello" } };
    let projections = 0;
    const states: string[] = [];
    const consumer = createQueueConsumer(registry, inbox, async () => {
      projections += 1;
      if (projections === 1) throw new Error("projection unavailable");
    });
    const batch = { messages: [{ body: event, ack: () => states.push("ack"), retry: () => states.push("retry") }] };
    expect(await consumer(batch, {})).toEqual({ acknowledged: 0, retried: 1 });
    expect(await consumer(batch, {})).toEqual({ acknowledged: 1, retried: 0 });
    expect(await consumer(batch, {})).toEqual({ acknowledged: 1, retried: 0 });
    expect(projections).toBe(2);
    expect(states).toEqual(["retry", "ack", "ack"]);
    expect(await consumer({ messages: [{ body: { ...event, resource: { type: "article", id: "forged" } }, ack: () => states.push("ack"), retry: () => states.push("retry") }] }, {})).toEqual({ acknowledged: 0, retried: 1 });
  });

  it("hands a Queue event to one stable Workflow instance and retries its handler deterministically", async () => {
    const now = new Date("2026-09-22T00:00:00Z");
    const clock = { current: now, now() { return this.current; } };
    const workflows = new LocalWorkflowScheduler(clock);
    const registry = new EventConsumerRegistry();
    const inbox = new InMemoryEventInbox(clock);
    let attempts = 0;
    registry.register({ name: "article.published", schemaVersion: 1, parse: (payload) => payload }, async () => { attempts += 1; if (attempts === 1) throw new Error("temporary"); });
    const event = envelope();
    const binding = {
      create: async ({ id, params }: { id: string; params: typeof event }) => { if (workflows.list().some((job) => job.id === id)) throw new Error("duplicate instance"); workflows.schedule(params, now); return { id }; },
      get: async (id: string) => { if (!workflows.list().some((job) => job.id === id)) throw new Error("not found"); return { id }; },
    };
    const acknowledgements: string[] = [];
    const batch = { messages: [{ body: event, ack: () => acknowledgements.push("ack"), retry: () => acknowledgements.push("retry") }] };
    const consumer = createWorkflowQueueConsumer(registry, binding);
    expect(await consumer(batch)).toEqual({ acknowledged: 1, retried: 0 });
    expect(await consumer(batch)).toEqual({ acknowledged: 1, retried: 0 });
    expect(workflows.list()).toHaveLength(1);
    expect(workflows.list()[0]?.id).toBe(event.id);
    expect(await workflows.runDue(async (message) => await handleEventWithInbox(registry, inbox, message, {}), { retryDelayMs: 1_000 })).toBe(0);
    expect(workflows.list()[0]).toMatchObject({ status: "scheduled", attempts: 1 });
    clock.current = new Date(now.getTime() + 1_000);
    expect(await workflows.runDue(async (message) => await handleEventWithInbox(registry, inbox, message, {}))).toBe(1);
    expect(workflows.list()[0]).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(attempts).toBe(2);
    expect(acknowledgements).toEqual(["ack", "ack"]);
  });

  it("retries Queue delivery when Workflow creation and lookup both fail", async () => {
    const registry = new EventConsumerRegistry();
    registry.register({ name: "article.published", schemaVersion: 1, parse: (payload) => payload }, async () => undefined);
    const states: string[] = [];
    const consumer = createWorkflowQueueConsumer(registry, { create: async () => { throw new Error("provider unavailable"); }, get: async () => { throw new Error("not found"); } });
    expect(await consumer({ messages: [{ body: envelope(), ack: () => states.push("ack"), retry: () => states.push("retry") }] })).toEqual({ acknowledged: 0, retried: 1 });
    expect(states).toEqual(["retry"]);
  });
});
