import { defineEvent, defineEventCatalog, eventEnvelopeSchema } from "@__TRESTLE_PROJECT_NAME__/events";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createTenantDatabase } from "./index.js";
import { PostgresOutboxStore } from "./outbox.js";
import { projectCommittedWebhook } from "./webhook-projection.js";
import { dueNativeWebhookWakeups } from "./webhook-recovery.js";
import { expireNativeWebhookDelivery, expireUnprovenNativeWebhookDeliveries, parseNativeWebhookWakeup, resolveNativeWebhookWork } from "./webhook-work.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false }) : undefined;
const outbox = databaseUrl ? new PostgresOutboxStore(databaseUrl) : undefined;
const eventIds: string[] = [];
const endpointIds: string[] = [];
const tenantDatabase = (organizationId: string) => createTenantDatabase(databaseUrl!, "postgres-js", organizationId);

const articleSchema = z.object({ articleId: z.string().min(1), title: z.string().min(1) });
const publicArticle = defineEvent({
  name: "article.published", schemaVersion: 1, description: "Article publication", sensitivity: "internal",
  resource: { type: "article", id: (payload: z.infer<typeof articleSchema>) => payload.articleId }, payload: articleSchema,
  webhook: { type: "article.published", version: 1, description: "An article was published", payload: articleSchema,
    project: (payload) => ({ articleId: payload.articleId, title: payload.title }),
    sensitivity: { classification: "customer", retentionClass: "standard" },
    examples: [{ articleId: "article-example", title: "Example" }],
    fixtures: [{ internal: { articleId: "article-example", title: "Example" }, public: { articleId: "article-example", title: "Example" } }],
  },
});
const privateArticle = defineEvent({ name: "article.reviewed", schemaVersion: 1, description: "Internal review", sensitivity: "internal",
  resource: { type: "article", id: (payload: z.infer<typeof articleSchema>) => payload.articleId }, payload: articleSchema });
const catalog = defineEventCatalog([publicArticle, privateArticle]);
const entitledCatalog = defineEventCatalog([defineEvent({
  name: "article.published", schemaVersion: 1, description: "Article publication", sensitivity: "internal",
  resource: { type: "article", id: (payload: z.infer<typeof articleSchema>) => payload.articleId }, payload: articleSchema,
  webhook: { type: "article.published", version: 1, description: "An article was published", payload: articleSchema,
    project: (payload) => ({ articleId: payload.articleId, title: payload.title }),
    sensitivity: { classification: "customer", retentionClass: "short" }, entitlement: "webhooks.outbound.enabled",
    examples: [{ articleId: "article-example", title: "Example" }],
    fixtures: [{ internal: { articleId: "article-example", title: "Example" }, public: { articleId: "article-example", title: "Example" } }],
  },
})]);

const committedAt = new Date("2026-09-22T18:30:00.000Z");
const day = 86_400_000;

async function commit(name: string, organizationId?: string): Promise<string> {
  const id = crypto.randomUUID();
  eventIds.push(id);
  await outbox!.append(eventEnvelopeSchema.parse({ id, name, schemaVersion: 1, occurredAt: committedAt.toISOString(), resource: { type: "article", id: "article-1" }, correlationId: `correlation-${id}`, idempotencyKey: id, payload: { articleId: "article-1", title: "Hello" } }), organizationId ? { organizationId } : {});
  return id;
}

async function subscribe(organizationId: string, state: "active" | "paused", environment = "local"): Promise<string> {
  const [record] = await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by) values (${organizationId}, ${environment}, ${crypto.randomUUID()}, 'https://example.test/webhook', ${state}, 'local', 'test-user', 'test-user') returning id`;
  if (!record) throw new Error("Endpoint insert failed");
  endpointIds.push(record.id);
  await sql!`insert into webhook_subscription (organization_id, endpoint_id, public_event_type, public_version, created_by) values (${organizationId}, ${record.id}, 'article.published', 1, 'test-user')`;
  return record.id;
}

suite("committed outbound webhook projection", () => {
  afterAll(async () => {
    if (endpointIds.length) await sql!`delete from webhook_delivery where endpoint_id = any(${endpointIds})`;
    if (eventIds.length) await sql!`delete from webhook_message where source_event_id = any(${eventIds})`;
    if (endpointIds.length) await sql!`delete from webhook_endpoint where id = any(${endpointIds})`;
    if (eventIds.length) await sql!`delete from outbox_message where id = any(${eventIds})`;
    await outbox!.close();
    await sql!.end();
  });

  it("projects once from the committed tenant and snapshots eligible endpoints", async () => {
    const id = await commit("article.published", "projection-org-a");
    const active = await subscribe("projection-org-a", "active");
    await subscribe("projection-org-a", "paused");
    await subscribe("projection-org-b", "active");
    await subscribe("projection-org-a", "active", "staging");
    const input = { eventId: id, environment: "local" as const, catalog, outbox: outbox!, tenantDatabase, now: () => new Date("2026-09-22T18:30:01.000Z") };
    const first = await projectCommittedWebhook(input);
    expect(first).toMatchObject({ state: "ready", deliveries: 1, created: true });
    if (first.state === "private") throw new Error("Expected public projection");
    const [message] = await sql!`select organization_id, source_event_id, public_event_type, public_version, envelope, payload_size, entitlement_decision, correlation_id from webhook_message where id=${first.messageId}`;
    expect(message).toMatchObject({ organization_id: "projection-org-a", source_event_id: id, public_event_type: "article.published", public_version: 1, entitlement_decision: "not_required", envelope: { id: first.messageId, organizationId: "projection-org-a", data: { articleId: "article-1", title: "Hello" } } });
    expect(message?.payload_size).toBeGreaterThan(0);
    const [delivery] = await sql!`select endpoint_id, state, next_attempt_at from webhook_delivery where message_id=${first.messageId}`;
    expect(delivery).toMatchObject({ endpoint_id: active, state: "pending", next_attempt_at: new Date("2026-09-22T18:30:01.000Z") });
    await sql!`update webhook_endpoint set state='paused' where id=${active}`;
    expect(await projectCommittedWebhook(input)).toEqual({ state: "ready", messageId: first.messageId, deliveries: 1, created: false });
    expect((await sql!`select id from webhook_delivery where message_id=${first.messageId}`)).toHaveLength(1);
  });

  it("does not project private events or accept public events without committed tenant provenance", async () => {
    const privateId = await commit("article.reviewed", "projection-org-a");
    expect(await projectCommittedWebhook({ eventId: privateId, environment: "local", catalog, outbox: outbox!, tenantDatabase })).toEqual({ state: "private" });
    const unscopedId = await commit("article.published");
    await expect(projectCommittedWebhook({ eventId: unscopedId, environment: "local", catalog, outbox: outbox!, tenantDatabase })).rejects.toThrow("tenant provenance");
    expect((await sql!`select id from webhook_message where source_event_id in (${privateId},${unscopedId})`)).toHaveLength(0);
  });

  it("persists an entitlement denial without payload or deliveries", async () => {
    const id = await commit("article.published", "projection-org-denied");
    await subscribe("projection-org-denied", "active");
    const result = await projectCommittedWebhook({ eventId: id, environment: "local", catalog: entitledCatalog, outbox: outbox!, tenantDatabase, hasEntitlement: async () => false });
    expect(result).toMatchObject({ state: "suppressed", deliveries: 0, created: true });
    if (result.state === "private") throw new Error("Expected public projection");
    expect((await sql!`select envelope, payload_size, entitlement_decision, status from webhook_message where id=${result.messageId}`)[0]).toEqual({ envelope: null, payload_size: 0, entitlement_decision: "denied", status: "suppressed" });
    expect((await sql!`select id from webhook_delivery where message_id=${result.messageId}`)).toHaveLength(0);
  });

  it("rejects oversized public payloads before any persistence", async () => {
    const id = await commit("article.published", "projection-org-size");
    await expect(projectCommittedWebhook({ eventId: id, environment: "local", catalog, outbox: outbox!, tenantDatabase, maxPayloadBytes: 1 })).rejects.toThrow("exceeds");
    expect((await sql!`select id from webhook_message where source_event_id=${id}`)).toHaveLength(0);
  });

  it("forces tenant isolation for public messages and deliveries", async () => {
    const id = await commit("article.published", "projection-org-isolated");
    await subscribe("projection-org-isolated", "active");
    const result = await projectCommittedWebhook({ eventId: id, environment: "local", catalog, outbox: outbox!, tenantDatabase });
    if (result.state === "private") throw new Error("Expected public projection");
    await sql!.begin(async (transaction) => {
      await transaction`set local role trestle_app`;
      expect(await transaction`select id from webhook_message where id=${result.messageId}`).toHaveLength(0);
      expect(await transaction`select id from webhook_delivery where message_id=${result.messageId}`).toHaveLength(0);
      await transaction`select set_config('app.organization_id', 'projection-org-isolated', true)`;
      expect(await transaction`select id from webhook_message where id=${result.messageId}`).toHaveLength(1);
      expect(await transaction`select id from webhook_delivery where message_id=${result.messageId}`).toHaveLength(1);
      expect((await transaction`update webhook_message set status='suppressed' where id=${result.messageId} and organization_id='other-org'`).count).toBe(0);
    });
    const forced = await sql!`select relname, relforcerowsecurity from pg_class where relname in ('webhook_message','webhook_delivery') order by relname`;
    expect(forced).toEqual([{ relname: "webhook_delivery", relforcerowsecurity: true }, { relname: "webhook_message", relforcerowsecurity: true }]);
  });

  it("resolves ID-only native Queue work from committed provenance under tenant RLS", async () => {
    const firstEvent = await commit("article.published", "work-org-a");
    const otherSameTenantEvent = await commit("article.published", "work-org-a");
    const secondEvent = await commit("article.published", "work-org-b");
    const endpoint = async (organizationId: string) => {
      const [record] = await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by) values (${organizationId}, 'preview', ${crypto.randomUUID()}, 'https://example.test/hook', 'active', 'native', 'test-user', 'test-user') returning id`;
      endpointIds.push(record!.id);
      await sql!`insert into webhook_subscription (organization_id, endpoint_id, public_event_type, public_version, created_by) values (${organizationId}, ${record!.id}, 'article.published', 1, 'test-user')`;
      return record!.id;
    };
    const firstEndpoint = await endpoint("work-org-a");
    await endpoint("work-org-b");
    for (const eventId of [firstEvent, otherSameTenantEvent, secondEvent]) {
      await projectCommittedWebhook({ eventId, environment: "preview", catalog, outbox: outbox!, tenantDatabase });
    }
    const [firstDelivery] = await sql!<{ id: string }[]>`select d.id from webhook_delivery d join webhook_message m on m.id=d.message_id where m.source_event_id=${firstEvent}`;
    const [secondDelivery] = await sql!<{ id: string }[]>`select d.id from webhook_delivery d join webhook_message m on m.id=d.message_id where m.source_event_id=${secondEvent}`;
    const wakeup = { sourceEventId: firstEvent, deliveryId: firstDelivery!.id };
    const resolve = (work: unknown, environment: "preview" | "staging" = "preview") => resolveNativeWebhookWork({ wakeup: work, environment, outbox: outbox!, tenantDatabase, now: committedAt });
    expect(parseNativeWebhookWakeup(wakeup)).toEqual(wakeup);
    expect(await resolve(wakeup)).toEqual({ state: "ready", organizationId: "work-org-a", deliveryId: firstDelivery!.id });
    expect(await resolve(wakeup)).toEqual({ state: "ready", organizationId: "work-org-a", deliveryId: firstDelivery!.id });
    expect(await resolve({ ...wakeup, deliveryId: secondDelivery!.id })).toEqual({ state: "not_found" });
    expect(await resolve({ ...wakeup, sourceEventId: otherSameTenantEvent })).toEqual({ state: "not_found" });
    expect(await resolve({ ...wakeup, sourceEventId: secondEvent })).toEqual({ state: "not_found" });
    expect(await resolve({ ...wakeup, sourceEventId: crypto.randomUUID() })).toEqual({ state: "not_found" });
    expect(await resolve(wakeup, "staging")).toEqual({ state: "not_native" });
    await sql!`update webhook_endpoint set state='paused' where id=${firstEndpoint}`;
    expect(await resolve(wakeup)).toEqual({ state: "inactive" });
    expect(() => parseNativeWebhookWakeup({ ...wakeup, organizationId: "work-org-b" })).toThrow("Invalid native webhook wake-up");
    expect(() => parseNativeWebhookWakeup({ ...wakeup, deliveryId: "whd_not_an_id" })).toThrow("Invalid native webhook wake-up");
  });

  describe("native work whose provenance is gone", () => {
    const subscribed = new Set<string>();
    const nativeDelivery = async (organizationId: string) => {
      if (!subscribed.has(organizationId)) await nativeEndpoint(organizationId);
      subscribed.add(organizationId);
      const eventId = await commit("article.published", organizationId);
      await projectCommittedWebhook({ eventId, environment: "preview", catalog, outbox: outbox!, tenantDatabase, now: () => committedAt });
      const [delivery] = await sql!<{ id: string }[]>`select d.id from webhook_delivery d join webhook_message m on m.id=d.message_id where m.source_event_id=${eventId}`;
      return { eventId, deliveryId: delivery!.id };
    };
    const nativeEndpoint = async (organizationId: string) => {
      const [endpoint] = await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by) values (${organizationId}, 'preview', ${crypto.randomUUID()}, 'https://example.test/hook', 'active', 'native', 'test-user', 'test-user') returning id`;
      endpointIds.push(endpoint!.id);
      await sql!`insert into webhook_subscription (organization_id, endpoint_id, public_event_type, public_version, created_by) values (${organizationId}, ${endpoint!.id}, 'article.published', 1, 'test-user')`;
    };
    const state = async (deliveryId: string) => (await sql!`select state, terminal_reason, completed_at is not null as completed, next_attempt_at, lease_token from webhook_delivery where id=${deliveryId}`)[0];
    const exhausted = { state: "exhausted", terminal_reason: "provenance_expired", completed: true, next_attempt_at: null, lease_token: null };

    it("accepts replay delivery IDs in wake-ups", () => {
      const wakeup = { sourceEventId: crypto.randomUUID(), deliveryId: `whd_replay_${crypto.randomUUID().replaceAll("-", "")}` };
      expect(parseNativeWebhookWakeup(wakeup)).toEqual(wakeup);
    });

    it("resolves work past the 14-day replay window as expired and settles the delivery as exhausted", async () => {
      const organizationId = `expired-work-${crypto.randomUUID()}`;
      const { eventId, deliveryId } = await nativeDelivery(organizationId);
      const wakeup = { sourceEventId: eventId, deliveryId };
      const boundary = new Date(committedAt.getTime() + 14 * day);
      expect(await resolveNativeWebhookWork({ wakeup, environment: "preview", outbox: outbox!, tenantDatabase, now: boundary })).toEqual({ state: "ready", organizationId, deliveryId });
      const later = new Date(boundary.getTime() + 1);
      expect(await resolveNativeWebhookWork({ wakeup, environment: "preview", outbox: outbox!, tenantDatabase, now: later })).toEqual({ state: "expired", organizationId, deliveryId });
      // A delivery still inside a live lease is left to its current attempt.
      await sql!`update webhook_delivery set state='leased', lease_token=${crypto.randomUUID()}, leased_until=${new Date(later.getTime() + 60_000)} where id=${deliveryId}`;
      expect(await expireNativeWebhookDelivery({ organizationId, deliveryId, tenantDatabase, now: later })).toBe(false);
      await sql!`update webhook_delivery set state='retry', lease_token=null, leased_until=null, next_attempt_at=${later} where id=${deliveryId}`;
      expect(await expireNativeWebhookDelivery({ organizationId, deliveryId, tenantDatabase, now: later })).toBe(true);
      expect(await state(deliveryId)).toEqual(exhausted);
      expect(await expireNativeWebhookDelivery({ organizationId, deliveryId, tenantDatabase, now: later })).toBe(false);
      // Another tenant's context cannot settle it.
      await sql!`update webhook_delivery set state='retry', terminal_reason=null, completed_at=null where id=${deliveryId}`;
      expect(await expireNativeWebhookDelivery({ organizationId: `${organizationId}-other`, deliveryId, tenantDatabase, now: later })).toBe(false);
      expect(await state(deliveryId)).toMatchObject({ state: "retry" });
    });

    it("settles due deliveries whose source event was pruned or aged out, so recovery stops waking them", async () => {
      const organizationId = `unproven-work-${crypto.randomUUID()}`;
      const pruned = await nativeDelivery(organizationId);
      const aged = await nativeDelivery(organizationId);
      const fresh = await nativeDelivery(organizationId);
      const now = new Date(committedAt.getTime() + 60_000);
      await sql!`delete from outbox_message where id=${pruned.eventId}`;
      await sql!`update outbox_message set occurred_at=${new Date(now.getTime() - 14 * day - 1)} where id=${aged.eventId}`;
      // Another tenant's matching deliveries are out of reach.
      expect(await expireUnprovenNativeWebhookDeliveries({ organizationId: `${organizationId}-other`, environment: "preview", tenantDatabase, now })).toBe(0);
      expect(await expireUnprovenNativeWebhookDeliveries({ organizationId, environment: "preview", tenantDatabase, now })).toBe(2);
      expect(await state(pruned.deliveryId)).toEqual(exhausted);
      expect(await state(aged.deliveryId)).toEqual(exhausted);
      expect(await state(fresh.deliveryId)).toMatchObject({ state: "pending", terminal_reason: null });
      expect(await dueNativeWebhookWakeups({ organizationId, environment: "preview", tenantDatabase, now })).toEqual([{ sourceEventId: fresh.eventId, deliveryId: fresh.deliveryId }]);
      expect(await expireUnprovenNativeWebhookDeliveries({ organizationId, environment: "preview", tenantDatabase, now })).toBe(0);
    });
  });
});
