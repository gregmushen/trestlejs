import type { Logger } from "@__TRESTLE_PROJECT_NAME__/context";
import { applicationEventCatalog, defineEvent, defineEventCatalog, eventEnvelopeSchema, InMemoryEventInbox, LocalWorkflowScheduler, PermanentEventError, type EventEnvelope, type EventInboxStore, type OutboxEntry, type QueueSettlement } from "@__TRESTLE_PROJECT_NAME__/events";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createQueueConsumer, createWorkflowQueueConsumer, EventConsumerRegistry, handleEventWithInbox, type EventHandlerContext } from "./async-runtime.js";
import { projectWebhookForEvent } from "./webhook-runtime.js";

const envelope = (overrides: Partial<EventEnvelope> = {}) => eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "article.published", schemaVersion: 1, occurredAt: new Date().toISOString(), resource: { type: "article", id: "article-1" }, correlationId: "correlation-1", idempotencyKey: `article-1:published:${crypto.randomUUID()}`, payload: { title: "Hello" }, ...overrides });
const definition = { name: "article.published", schemaVersion: 1, parse: (payload: unknown) => payload as { title: string } };

/** A fake committed outbox: rows are what the database holds, independent of what a Queue delivers. */
function committedStore() {
  const rows = new Map<string, OutboxEntry>();
  let failure: Error | undefined;
  const lookups: string[] = [];
  return {
    lookups,
    commit(message: EventEnvelope, organizationId: string | null = "org-1") {
      rows.set(message.id, { id: message.id, message, ...(organizationId ? { organizationId } : {}), status: "succeeded", attempts: 0, availableAt: new Date(message.occurredAt) });
      return message;
    },
    tamper(id: string, message: EventEnvelope) { const row = rows.get(id)!; rows.set(id, { ...row, message }); },
    fail(error: Error | undefined) { failure = error; },
    async findCommitted(id: string) { lookups.push(id); if (failure) throw failure; return rows.get(id) ?? null; },
  };
}

function trackingInbox(inner: EventInboxStore = new InMemoryEventInbox()) {
  const claims: string[] = [];
  const releases: string[] = [];
  const inbox: EventInboxStore = {
    claim: async (message, leaseMs) => { claims.push(message.idempotencyKey); return await inner.claim(message, leaseMs); },
    complete: async (key, token) => await inner.complete(key, token),
    release: async (key, token, error) => { releases.push(key); await inner.release(key, token, error); },
  };
  return { inbox, claims, releases };
}

function recordingLogger() {
  const records: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  const make = (fields: Record<string, unknown>): Logger => {
    const write = (level: string) => (event: string, context: Readonly<Record<string, unknown>> = {}) => { records.push({ level, event, fields: { ...fields, ...context } }); };
    return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error"), child: (extra: Readonly<Record<string, unknown>>) => make({ ...fields, ...extra }) } as Logger;
  };
  return { records, logger: (fields: Record<string, unknown>) => make(fields) };
}

const message = (body: unknown, states: string[]) => ({ body, ack: () => states.push("ack"), retry: () => states.push("retry") });
const silent = () => recordingLogger().logger;

describe("Worker Queue consumer", () => {
  it("validates, dispatches, preserves correlation, and acknowledges a registered versioned event", async () => { const handled: string[] = []; const registry = new EventConsumerRegistry<{ marker: string }>(undefined, { logger: silent() }); registry.register(definition, async (payload, event, environment) => { handled.push(`${environment.marker}:${payload.title}:${event.correlationId}`); }); const store = committedStore(); const states: string[] = []; const result = await createQueueConsumer(registry, new InMemoryEventInbox(), store)({ messages: [message(store.commit(envelope()), states)] }, { marker: "worker" }); expect(result).toEqual({ acknowledged: 1, retried: 0 }); expect(states).toEqual(["ack"]); expect(handled).toEqual(["worker:Hello:correlation-1"]); });
  it("retries unknown and invalid messages", async () => { const registry = new EventConsumerRegistry(undefined, { logger: silent() }); const store = committedStore(); const states: string[] = []; const result = await createQueueConsumer(registry, new InMemoryEventInbox(), store)({ messages: [message(store.commit(envelope()), states), message({}, states)] }, {}); expect(result).toEqual({ acknowledged: 0, retried: 2 }); expect(states).toEqual(["retry", "retry"]); });
  it("acknowledges internal billing events without publishing a customer webhook", async () => {
    const payload = { organizationId: "org-billing", plan: "pro", planVersion: 1, status: "active",
      entitlements: ["article.basic"], cancelAtPeriodEnd: false };
    const event = eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "billing.subscription.activated", schemaVersion: 1,
      occurredAt: new Date().toISOString(), resource: { type: "organization", id: payload.organizationId },
      correlationId: "billing-correlation", idempotencyKey: "billing:stripe:evt_one", payload });
    const store = committedStore();
    store.commit(event, payload.organizationId);
    const states: string[] = [];
    const consumer = createQueueConsumer(new EventConsumerRegistry(applicationEventCatalog, { logger: silent() }), new InMemoryEventInbox(), store,
      async (queued) => { expect(applicationEventCatalog.project(queued.name, queued.schemaVersion, queued.payload)).toBeNull(); });
    expect(await consumer({ messages: [message(event, states)] }, {}))
      .toEqual({ acknowledged: 1, retried: 0 });
    expect(states).toEqual(["ack"]);
  });
  it("skips completed duplicate logical events and retries transient handler failures", async () => {
    const registry = new EventConsumerRegistry(undefined, { logger: silent() });
    const { inbox, releases } = trackingInbox();
    let attempts = 0;
    registry.register(definition, async () => { attempts += 1; if (attempts === 1) throw new Error("temporary"); });
    const store = committedStore();
    const consumer = createQueueConsumer(registry, inbox, store);
    const event = store.commit(envelope());
    const states: string[] = [];
    const batch = { messages: [message(event, states)] };
    expect(await consumer(batch, {})).toEqual({ acknowledged: 0, retried: 1 });
    expect(releases).toEqual([event.idempotencyKey]);
    expect(await consumer(batch, {})).toEqual({ acknowledged: 1, retried: 0 });
    expect(await consumer(batch, {})).toEqual({ acknowledged: 1, retried: 0 });
    expect(attempts).toBe(2);
    expect(states).toEqual(["retry", "ack", "ack"]);
  });
  it("rejects duplicate consumer registrations", () => { const registry = new EventConsumerRegistry(); registry.register(definition, async () => undefined); expect(() => registry.register(definition, async () => undefined)).toThrow("already registered"); });

  it("processes catalog-declared events without a bespoke consumer and keeps projection inside the inbox retry boundary", async () => {
    const catalog = defineEventCatalog([defineEvent({
      name: "article.published", schemaVersion: 1, description: "Article published", sensitivity: "internal",
      resource: { type: "article", id: (payload: { title: string }) => payload.title }, payload: z.object({ title: z.string() }),
    })]);
    const registry = new EventConsumerRegistry(catalog, { logger: silent() });
    const inbox = new InMemoryEventInbox();
    const store = committedStore();
    const event = store.commit(envelope({ resource: { type: "article", id: "Hello" } }));
    let projections = 0;
    const states: string[] = [];
    const consumer = createQueueConsumer(registry, inbox, store, async () => {
      projections += 1;
      if (projections === 1) throw new Error("projection unavailable");
    });
    const batch = { messages: [message(event, states)] };
    expect(await consumer(batch, {})).toEqual({ acknowledged: 0, retried: 1 });
    expect(await consumer(batch, {})).toEqual({ acknowledged: 1, retried: 0 });
    expect(await consumer(batch, {})).toEqual({ acknowledged: 1, retried: 0 });
    expect(projections).toBe(2);
    expect(states).toEqual(["retry", "ack", "ack"]);
    expect(await consumer({ messages: [message({ ...event, resource: { type: "article", id: "forged" } }, states)] }, {})).toEqual({ acknowledged: 0, retried: 1 });
  });

  it("hands a Queue event to one stable Workflow instance and retries its handler deterministically", async () => {
    const now = new Date("2026-09-22T00:00:00Z");
    const clock = { current: now, now() { return this.current; } };
    const workflows = new LocalWorkflowScheduler(clock);
    const registry = new EventConsumerRegistry(undefined, { clock, logger: silent() });
    const inbox = new InMemoryEventInbox(clock);
    const store = committedStore();
    let attempts = 0;
    registry.register(definition, async () => { attempts += 1; if (attempts === 1) throw new Error("temporary"); });
    const event = store.commit(envelope({ occurredAt: now.toISOString() }));
    const binding = {
      create: async ({ id, params }: { id: string; params: typeof event }) => { if (workflows.list().some((job) => job.id === id)) throw new Error("duplicate instance"); workflows.schedule(params, now); return { id }; },
      get: async (id: string) => { if (!workflows.list().some((job) => job.id === id)) throw new Error("not found"); return { id }; },
    };
    const acknowledgements: string[] = [];
    const batch = { messages: [{ body: event, ack: () => acknowledgements.push("ack"), retry: () => acknowledgements.push("retry") }] };
    const consumer = createWorkflowQueueConsumer(registry, binding, store);
    expect(await consumer(batch)).toEqual({ acknowledged: 1, retried: 0 });
    expect(await consumer(batch)).toEqual({ acknowledged: 1, retried: 0 });
    expect(workflows.list()).toHaveLength(1);
    expect(workflows.list()[0]?.id).toBe(event.id);
    expect(await workflows.runDue(async (queued) => await handleEventWithInbox(registry, inbox, store, queued, {}), { retryDelayMs: 1_000 })).toBe(0);
    expect(workflows.list()[0]).toMatchObject({ status: "scheduled", attempts: 1 });
    clock.current = new Date(now.getTime() + 1_000);
    expect(await workflows.runDue(async (queued) => await handleEventWithInbox(registry, inbox, store, queued, {}))).toBe(1);
    expect(workflows.list()[0]).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(attempts).toBe(2);
    expect(acknowledgements).toEqual(["ack", "ack"]);
  });

  it("retries Queue delivery when Workflow creation and lookup both fail", async () => {
    const registry = new EventConsumerRegistry(undefined, { logger: silent() });
    registry.register(definition, async () => undefined);
    const store = committedStore();
    const states: string[] = [];
    const consumer = createWorkflowQueueConsumer(registry, { create: async () => { throw new Error("provider unavailable"); }, get: async () => { throw new Error("not found"); } }, store);
    expect(await consumer({ messages: [message(store.commit(envelope()), states)] })).toEqual({ acknowledged: 0, retried: 1 });
    expect(states).toEqual(["retry"]);
  });
});

describe("Verified handler authority", () => {
  it("gives an undeclared handler the committed event, organization, logger, and clock, but no database", async () => {
    const clock = { now: () => new Date() };
    const tenantCalls: string[] = [];
    const registry = new EventConsumerRegistry<{ marker: string }, { tenant: string }>(undefined, { clock, logger: silent(), tenantData: (_environment, organizationId) => { tenantCalls.push(organizationId); return { tenant: organizationId }; } });
    const contexts: EventHandlerContext<{ tenant: string }>[] = [];
    const received: EventEnvelope[] = [];
    registry.register(definition, async (_payload, event, _environment, context) => { received.push(event); contexts.push(context); });
    const store = committedStore();
    const committed = store.commit(envelope({ occurredAt: "2026-09-22T00:00:00Z" }), "org-verified");
    // The Queue may reformat an equivalent instant; the handler still sees the committed row.
    const delivered = { ...committed, occurredAt: "2026-09-22T00:00:00.000Z" };
    await handleEventWithInbox(registry, new InMemoryEventInbox(), store, delivered, { marker: "worker" });
    expect(received[0]).toBe(committed);
    expect(contexts[0]).toMatchObject({ event: committed, authority: "verified", organizationId: "org-verified", clock });
    expect(typeof contexts[0]?.log.info).toBe("function");
    expect(contexts[0]?.data).toBeUndefined();
    expect(tenantCalls).toEqual([]);
  });

  it("creates tenant data lazily, only when a tenant handler reads it", async () => {
    const tenantCalls: string[] = [];
    const registry = new EventConsumerRegistry<unknown, { tenant: string }>(undefined, { logger: silent(), tenantData: (_environment, organizationId) => { tenantCalls.push(organizationId); return { tenant: organizationId }; } });
    const seen: Array<string | undefined> = [];
    let read = false;
    registry.register(definition, async (_payload, _event, _environment, context) => {
      expect(context.authority).toBe("tenant");
      expect(tenantCalls).toEqual([]);
      if (read) { seen.push(context.data?.tenant); seen.push(context.data?.tenant); }
    }, { authority: "tenant" });
    const store = committedStore();
    await handleEventWithInbox(registry, new InMemoryEventInbox(), store, store.commit(envelope(), "org-a"), {});
    expect(tenantCalls).toEqual([]);
    read = true;
    await handleEventWithInbox(registry, new InMemoryEventInbox(), store, store.commit(envelope(), "org-a"), {});
    expect(seen).toEqual(["org-a", "org-a"]);
    expect(tenantCalls).toEqual(["org-a"]);
  });

  it("refuses to register a tenant handler without a tenant data factory", () => {
    expect(() => new EventConsumerRegistry().register(definition, async () => undefined, { authority: "tenant" })).toThrow("tenant data");
    expect(() => new EventConsumerRegistry().register(definition, async () => undefined, { requires: { entitlement: "article.basic" } })).toThrow("entitlement");
  });

  it("checks the current entitlement at handling time and never invokes an unentitled handler", async () => {
    let entitled = false;
    const checks: string[] = [];
    const registry = new EventConsumerRegistry(undefined, { logger: silent(), hasEntitlement: async (_environment, organizationId, entitlement) => { checks.push(`${organizationId}:${entitlement}`); return entitled; } });
    let handled = 0;
    registry.register(definition, async () => { handled += 1; }, { requires: { entitlement: "workflows.advanced" } });
    const store = committedStore();
    const { inbox, claims } = trackingInbox();
    const event = store.commit(envelope(), "org-paid");
    await expect(handleEventWithInbox(registry, inbox, store, event, {})).rejects.toMatchObject({ name: "PermanentEventError", reason: "not_entitled" });
    expect(handled).toBe(0);
    expect(claims).toEqual([]);
    entitled = true;
    await handleEventWithInbox(registry, inbox, store, event, {});
    expect(handled).toBe(1);
    expect(checks).toEqual(["org-paid:workflows.advanced", "org-paid:workflows.advanced"]);
  });

  it("rejects verified and tenant work without committed organization provenance", async () => {
    const registry = new EventConsumerRegistry(undefined, { logger: silent(), tenantData: () => ({}) });
    let handled = 0;
    registry.register(definition, async () => { handled += 1; }, { authority: "tenant" });
    registry.register({ ...definition, schemaVersion: 2 }, async () => { handled += 1; });
    const store = committedStore();
    const { inbox, claims } = trackingInbox();
    await expect(handleEventWithInbox(registry, inbox, store, store.commit(envelope(), null), {})).rejects.toMatchObject({ reason: "tenant_provenance_missing" });
    await expect(handleEventWithInbox(registry, inbox, store, store.commit(envelope({ schemaVersion: 2 }), null), {})).rejects.toMatchObject({ reason: "tenant_provenance_missing" });
    expect(handled).toBe(0);
    expect(claims).toEqual([]);
  });

  it("runs a system handler without an organization and without tenant data", async () => {
    const tenantCalls: string[] = [];
    const registry = new EventConsumerRegistry(undefined, { logger: silent(), tenantData: (_environment, organizationId) => { tenantCalls.push(organizationId); return {}; } });
    const contexts: EventHandlerContext[] = [];
    registry.register(definition, async (_payload, _event, _environment, context) => { contexts.push(context); expect(context.data).toBeUndefined(); }, { authority: "system" });
    const store = committedStore();
    await handleEventWithInbox(registry, new InMemoryEventInbox(), store, store.commit(envelope(), null), {});
    expect(contexts[0]).toMatchObject({ authority: "system" });
    expect(contexts[0]?.organizationId).toBeUndefined();
    expect(tenantCalls).toEqual([]);
  });

  it("never lets a forged or uncommitted delivery reach its handler, claim the inbox, or be acknowledged", async () => {
    const registry = new EventConsumerRegistry(undefined, { logger: silent() });
    const handled: string[] = [];
    registry.register(definition, async (payload) => { handled.push(payload.title); });
    const store = committedStore();
    const { inbox, claims } = trackingInbox();
    const settlements: QueueSettlement[] = [];
    const consumer = createQueueConsumer(registry, inbox, store, undefined, (settlement) => settlements.push(settlement));
    const committed = store.commit(envelope());
    const states: string[] = [];
    expect(await consumer({ messages: [
      message({ ...committed, payload: { title: "Forged" } }, states),
      message(envelope(), states),
    ] }, {})).toEqual({ acknowledged: 0, retried: 2 });
    expect(states).toEqual(["retry", "retry"]);
    expect(settlements.map((settlement) => settlement.reason)).toEqual(["provenance_mismatch", "provenance_missing"]);
    expect(handled).toEqual([]);
    expect(claims).toEqual([]);
  });

  it("verifies provenance even when outbound webhooks are disabled", async () => {
    const environment = { DATABASE_URL: "postgres://unused", BETTER_AUTH_SECRET: "unused", WEBHOOK_DELIVERY_MODE: "disabled" as const };
    const registry = new EventConsumerRegistry<typeof environment>(applicationEventCatalog, { logger: silent() });
    const store = committedStore();
    const { inbox, claims } = trackingInbox();
    const payload = { organizationId: "org-billing", plan: "pro", planVersion: 1, status: "active", entitlements: ["article.basic"], cancelAtPeriodEnd: false };
    const event = store.commit(eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "billing.subscription.activated", schemaVersion: 1,
      occurredAt: new Date().toISOString(), resource: { type: "organization", id: payload.organizationId },
      correlationId: "billing-correlation", idempotencyKey: `billing:stripe:${crypto.randomUUID()}`, payload }), payload.organizationId);
    const project = async (queued: EventEnvelope, current: typeof environment, committed?: OutboxEntry) => { await projectWebhookForEvent({ envelope: queued, environment: current, outbox: store, ...(committed ? { committed } : {}) }); };
    const states: string[] = [];
    const consumer = createQueueConsumer(registry, inbox, store, project);
    expect(await consumer({ messages: [message({ ...event, payload: { ...payload, plan: "enterprise" } }, states)] }, environment)).toEqual({ acknowledged: 0, retried: 1 });
    expect(claims).toEqual([]);
    expect(await consumer({ messages: [message(event, states)] }, environment)).toEqual({ acknowledged: 1, retried: 0 });
    expect(states).toEqual(["retry", "ack"]);
  });

  it("passes the committed row to post-commit work so projection need not query again", async () => {
    const registry = new EventConsumerRegistry(undefined, { logger: silent() });
    registry.register(definition, async () => undefined);
    const store = committedStore();
    const event = store.commit(envelope(), "org-1");
    const seen: Array<OutboxEntry | undefined> = [];
    await handleEventWithInbox(registry, new InMemoryEventInbox(), store, event, {}, async (_message, _environment, committed) => { seen.push(committed); });
    expect(seen[0]).toMatchObject({ id: event.id, organizationId: "org-1", message: event });
    expect(store.lookups).toEqual([event.id]);
  });

  it("gives concurrent events for different tenants their own organization and data", async () => {
    const tenantCalls: string[] = [];
    const registry = new EventConsumerRegistry<unknown, { tenant: string }>(undefined, { logger: silent(), tenantData: (_environment, organizationId) => { tenantCalls.push(organizationId); return { tenant: organizationId }; } });
    const seen: string[] = [];
    registry.register(definition, async (_payload, _event, _environment, context) => {
      await new Promise((resolve) => setTimeout(resolve, context.organizationId === "org-a" ? 10 : 0));
      seen.push(`${context.organizationId}:${context.data?.tenant}`);
    }, { authority: "tenant" });
    const store = committedStore();
    const inbox = new InMemoryEventInbox();
    await Promise.all([
      handleEventWithInbox(registry, inbox, store, store.commit(envelope(), "org-a"), {}),
      handleEventWithInbox(registry, inbox, store, store.commit(envelope(), "org-b"), {}),
    ]);
    expect(seen.sort()).toEqual(["org-a:org-a", "org-b:org-b"]);
    expect(tenantCalls.sort()).toEqual(["org-a", "org-b"]);
  });

  it("verifies before Workflow creation and creates the instance from the committed event", async () => {
    const registry = new EventConsumerRegistry(undefined, { logger: silent() });
    registry.register(definition, async () => undefined);
    const store = committedStore();
    const created: EventEnvelope[] = [];
    const binding = { create: async ({ id, params }: { id: string; params: EventEnvelope }) => { created.push(params); return { id }; }, get: async () => null };
    const committed = store.commit(envelope({ occurredAt: "2026-09-22T00:00:00Z" }));
    const settlements: QueueSettlement[] = [];
    const states: string[] = [];
    const consumer = createWorkflowQueueConsumer(registry, binding, store, (settlement) => settlements.push(settlement));
    // A forged message must never take the stable instance ID first.
    expect(await consumer({ messages: [message({ ...committed, payload: { title: "Forged" } }, states)] })).toEqual({ acknowledged: 0, retried: 1 });
    expect(created).toEqual([]);
    expect(settlements[0]?.reason).toBe("provenance_mismatch");
    expect(await consumer({ messages: [message({ ...committed, occurredAt: "2026-09-22T00:00:00.000Z" }, states)] })).toEqual({ acknowledged: 1, retried: 0 });
    expect(created).toHaveLength(1);
    expect(created[0]).toBe(committed);
    expect(states).toEqual(["retry", "ack"]);
  });

  it("rejects a committed event older than the replay window", async () => {
    const occurredAt = new Date("2026-09-01T00:00:00Z");
    const clock = { now: () => new Date(occurredAt.getTime() + 14 * 24 * 60 * 60 * 1_000 + 1) };
    const registry = new EventConsumerRegistry(undefined, { clock, logger: silent() });
    let handled = 0;
    registry.register(definition, async () => { handled += 1; });
    const store = committedStore();
    await expect(handleEventWithInbox(registry, new InMemoryEventInbox(), store, store.commit(envelope({ occurredAt: occurredAt.toISOString() })), {})).rejects.toMatchObject({ reason: "provenance_expired" });
    expect(handled).toBe(0);
  });

  it("keeps a committed-store outage retryable rather than permanent", async () => {
    const registry = new EventConsumerRegistry(undefined, { logger: silent() });
    registry.register(definition, async () => undefined);
    const store = committedStore();
    const event = store.commit(envelope());
    store.fail(new Error("database unavailable"));
    const error = await handleEventWithInbox(registry, new InMemoryEventInbox(), store, event, {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentEventError);
  });
});
