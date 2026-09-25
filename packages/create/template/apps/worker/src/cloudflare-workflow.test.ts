import type { Logger } from "@__TRESTLE_PROJECT_NAME__/context";
import { eventEnvelopeSchema, InMemoryEventInbox, type EventEnvelope, type OutboxEntry } from "@__TRESTLE_PROJECT_NAME__/events";
import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it } from "vitest";

import { createWorkflowQueueConsumer, EventConsumerRegistry } from "./async-runtime.js";
import { consumeWorkflowEvent } from "./cloudflare-workflow.js";

const dayMs = 24 * 60 * 60 * 1_000;
const definition = { name: "article.published", schemaVersion: 1, parse: (payload: unknown) => payload as { title: string } };
const envelope = (occurredAt: Date) => eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "article.published", schemaVersion: 1, occurredAt: occurredAt.toISOString(), resource: { type: "article", id: "article-1" }, correlationId: "correlation-1", idempotencyKey: `article-1:${crypto.randomUUID()}`, payload: { title: "Hello" } });

function committedStore() {
  const rows = new Map<string, OutboxEntry>();
  let failure: Error | undefined;
  return {
    commit(message: EventEnvelope, organizationId = "org-1") { rows.set(message.id, { id: message.id, message, organizationId, status: "succeeded", attempts: 0, availableAt: new Date(message.occurredAt) }); return message; },
    tamper(id: string, message: EventEnvelope) { const row = rows.get(id)!; rows.set(id, { ...row, message }); },
    fail(error: Error | undefined) { failure = error; },
    async findCommitted(id: string) { if (failure) throw failure; return rows.get(id) ?? null; },
  };
}

function recordingLogger() {
  const records: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  const make = (fields: Record<string, unknown>): Logger => {
    const write = (level: string) => (event: string, context: Readonly<Record<string, unknown>> = {}) => { records.push({ level, event, fields: { ...fields, ...context } }); };
    return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error"), child: (extra) => make({ ...fields, ...extra }) };
  };
  return { records, log: make({}), logger: (fields: Record<string, unknown>) => make(fields) };
}

/** Create the Workflow instance through the verified Queue path, then return what Cloudflare would hand to `run`. */
async function createInstance(registry: EventConsumerRegistry, store: ReturnType<typeof committedStore>, event: EventEnvelope) {
  const instances = new Map<string, EventEnvelope>();
  const binding = { create: async ({ id, params }: { id: string; params: EventEnvelope }) => { instances.set(id, params); return { id }; }, get: async (id: string) => instances.get(id) ?? null };
  expect(await createWorkflowQueueConsumer(registry, binding, store)({ messages: [{ body: event, ack: () => undefined, retry: () => undefined }] })).toEqual({ acknowledged: 1, retried: 0 });
  return instances.get(event.id)!;
}

describe("Workflow step execution", () => {
  it("reverifies provenance on every execution and fails a tampered committed row non-retryably", async () => {
    const registry = new EventConsumerRegistry(undefined, { logger: recordingLogger().logger });
    let handled = 0;
    registry.register(definition, async () => { handled += 1; });
    const store = committedStore();
    const event = store.commit(envelope(new Date()));
    const params = await createInstance(registry, store, event);
    store.tamper(event.id, { ...event, payload: { title: "Changed after creation" } });
    const { records, log } = recordingLogger();
    const error = await consumeWorkflowEvent({ registry, inbox: new InMemoryEventInbox(), outbox: store, envelope: params, environment: {}, workflowId: event.id, log }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(handled).toBe(0);
    expect(records).toEqual([expect.objectContaining({ level: "warn", event: "workflow.event.rejected", fields: expect.objectContaining({ workflowId: event.id, reason: "provenance_mismatch" }) })]);
  });

  it("fails non-retryably when the required entitlement is revoked after creation", async () => {
    let entitled = true;
    const registry = new EventConsumerRegistry(undefined, { logger: recordingLogger().logger, hasEntitlement: async () => entitled });
    let handled = 0;
    registry.register(definition, async () => { handled += 1; }, { requires: { entitlement: "workflows.advanced" } });
    const store = committedStore();
    const event = store.commit(envelope(new Date()));
    const params = await createInstance(registry, store, event);
    entitled = false;
    const { records, log } = recordingLogger();
    await expect(consumeWorkflowEvent({ registry, inbox: new InMemoryEventInbox(), outbox: store, envelope: params, environment: {}, workflowId: event.id, log })).rejects.toBeInstanceOf(NonRetryableError);
    expect(handled).toBe(0);
    expect(records[0]).toMatchObject({ event: "workflow.event.rejected", fields: { reason: "not_entitled" } });
  });

  it("keeps a committed-store outage retryable", async () => {
    const registry = new EventConsumerRegistry(undefined, { logger: recordingLogger().logger });
    registry.register(definition, async () => undefined);
    const store = committedStore();
    const event = store.commit(envelope(new Date()));
    const params = await createInstance(registry, store, event);
    store.fail(new Error("database unavailable"));
    const { records, log } = recordingLogger();
    const error = await consumeWorkflowEvent({ registry, inbox: new InMemoryEventInbox(), outbox: store, envelope: params, environment: {}, workflowId: event.id, log }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableError);
    expect((error as Error).message).toBe("Workflow handler failed");
    expect(records[0]).toMatchObject({ event: "workflow.event.retrying" });
  });

  it("rejects an event past the replay window at resumption, even after an earlier retryable attempt", async () => {
    const occurredAt = new Date("2026-09-01T00:00:00Z");
    const clock = { current: occurredAt, now() { return this.current; } };
    const registry = new EventConsumerRegistry(undefined, { clock, logger: recordingLogger().logger });
    let handled = 0;
    registry.register(definition, async () => { handled += 1; throw new Error("temporary"); });
    const store = committedStore();
    const event = store.commit(envelope(occurredAt));
    const params = await createInstance(registry, store, event);
    const inbox = new InMemoryEventInbox(clock);
    const { records, log } = recordingLogger();
    const first = await consumeWorkflowEvent({ registry, inbox, outbox: store, envelope: params, environment: {}, workflowId: event.id, log }).catch((caught: unknown) => caught);
    expect(first).not.toBeInstanceOf(NonRetryableError);
    expect(handled).toBe(1);
    clock.current = new Date(occurredAt.getTime() + 14 * dayMs + 1);
    await expect(consumeWorkflowEvent({ registry, inbox, outbox: store, envelope: params, environment: {}, workflowId: event.id, log })).rejects.toBeInstanceOf(NonRetryableError);
    expect(handled).toBe(1);
    expect(records.map((record) => [record.event, record.fields.reason])).toEqual([["workflow.event.retrying", undefined], ["workflow.event.rejected", "provenance_expired"]]);
  });

  it("completes a verified event and logs completion", async () => {
    const registry = new EventConsumerRegistry(undefined, { logger: recordingLogger().logger });
    let handled = 0;
    registry.register(definition, async () => { handled += 1; });
    const store = committedStore();
    const event = store.commit(envelope(new Date()));
    const params = await createInstance(registry, store, event);
    const { records, log } = recordingLogger();
    await consumeWorkflowEvent({ registry, inbox: new InMemoryEventInbox(), outbox: store, envelope: params, environment: {}, workflowId: event.id, log });
    expect(handled).toBe(1);
    expect(records[0]).toMatchObject({ event: "workflow.event.completed" });
  });
});
