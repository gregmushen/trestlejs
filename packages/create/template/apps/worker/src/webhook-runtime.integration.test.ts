import { createTenantDatabase, flushDueLocalWebhookDeliveries, loadCurrentWebhookSigningSecret, PostgresEventInbox, PostgresOutboxStore, WebhookSecretService } from "@__TRESTLE_PROJECT_NAME__/db";
import { defineEvent, defineEventCatalog, eventEnvelopeSchema } from "@__TRESTLE_PROJECT_NAME__/events";
import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createQueueConsumer, EventConsumerRegistry } from "./async-runtime.js";
import { projectWebhookForEvent } from "./webhook-runtime.js";
import { consumeNativeWebhookQueueMessages } from "./webhook-native-queue.js";
import { runNativeWebhookWakeup } from "./webhook-native-runtime.js";

const databaseUrl = process.env.TRESTLE_SYSTEM_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(process.env.TRESTLE_SYSTEM_TEST_MIGRATION_URL ?? databaseUrl, { max: 1, prepare: false }) : undefined;
const outbox = databaseUrl ? new PostgresOutboxStore(databaseUrl, { assumeApplicationRole: true }) : undefined;
const inbox = databaseUrl ? new PostgresEventInbox(databaseUrl, { assumeApplicationRole: true }) : undefined;
const ids: string[] = [];
const endpointIds: string[] = [];
const masterKey = "test-only-webhook-encryption-key-material-123456";
const payload = z.object({ articleId: z.string(), title: z.string() });
const catalog = defineEventCatalog([defineEvent({
  name: "article.published", schemaVersion: 1, description: "Article published", sensitivity: "internal",
  resource: { type: "article", id: (value: z.infer<typeof payload>) => value.articleId }, payload,
  webhook: { type: "article.published", version: 1, description: "Article published for customers", payload,
    project: (value) => value, sensitivity: { classification: "customer", retentionClass: "standard" },
    examples: [{ articleId: "example", title: "Example" }],
    fixtures: [{ internal: { articleId: "example", title: "Example" }, public: { articleId: "example", title: "Example" } }],
  },
})]);

suite("Queue to committed outbound webhook projection", () => {
  afterAll(async () => {
    if (endpointIds.length) await sql!`delete from webhook_attempt where delivery_id in (select id from webhook_delivery where endpoint_id = any(${endpointIds}))`;
    if (ids.length) await sql!`delete from webhook_delivery where message_id in (select id from webhook_message where source_event_id = any(${ids}))`;
    if (ids.length) await sql!`delete from webhook_message where source_event_id = any(${ids})`;
    if (endpointIds.length) await sql!`delete from webhook_secret_version where endpoint_id = any(${endpointIds})`;
    if (endpointIds.length) await sql!`delete from webhook_endpoint where id = any(${endpointIds})`;
    if (ids.length) await sql!`delete from event_inbox where idempotency_key = any(${ids})`;
    if (ids.length) await sql!`delete from outbox_message where id = any(${ids})`;
    await Promise.all([outbox!.close(), inbox!.close(), sql!.end()]);
  });

  it("projects a subscribed committed event once, then acknowledges duplicates", async () => {
    const organizationId = `webhook-runtime-${crypto.randomUUID()}`;
    const [endpoint] = await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by) values (${organizationId}, 'local', 'Runtime test', 'https://example.test/hook', 'active', 'local', 'test-user', 'test-user') returning id`;
    endpointIds.push(endpoint!.id);
    const tenantDatabase = (tenant: string) => createTenantDatabase(databaseUrl!, "postgres-js", tenant);
    const secretService = new WebhookSecretService({
      tenantDatabase, masterKey, environment: "local", clock: { now: () => new Date() },
      authority: { authorize: async () => ({ actorId: "test-user" }) },
    });
    const issued = await secretService.issue(organizationId, endpoint!.id);
    await sql!`insert into webhook_subscription (organization_id, endpoint_id, public_event_type, public_version, created_by) values (${organizationId}, ${endpoint!.id}, 'article.published', 1, 'test-user')`;
    const id = crypto.randomUUID();
    ids.push(id);
    const event = eventEnvelopeSchema.parse({ id, name: "article.published", schemaVersion: 1, occurredAt: new Date().toISOString(), resource: { type: "article", id: "article-1" }, correlationId: id, idempotencyKey: id, payload: { articleId: "article-1", title: "Hello" } });
    await outbox!.append(event, { organizationId });
    const environment = { DATABASE_URL: databaseUrl!, DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-only-secret", APP_ENV: "local" as const, WEBHOOK_DELIVERY_MODE: "local" as const, WEBHOOK_SECRET_KEY: masterKey };
    const registry = new EventConsumerRegistry(catalog);
    let now = new Date();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Local webhooks must not use the network"); });
    const consumer = createQueueConsumer(registry, inbox!, outbox!, async (envelope, _environment, committed) => {
      await projectWebhookForEvent({ envelope, environment, outbox: outbox!, ...(committed ? { committed } : {}), catalog, now: () => now,
        localScenario: { kind: "fail-times", count: 1, status: 503 } });
    });
    try {
      expect(await projectWebhookForEvent({ envelope: event, environment: { ...environment, WEBHOOK_DELIVERY_MODE: "disabled" }, outbox: outbox!, catalog })).toBeNull();
      await expect(projectWebhookForEvent({ envelope: event, environment: { ...environment, WEBHOOK_DELIVERY_MODE: "native" }, outbox: outbox!, catalog })).rejects.toThrow("remote environment, Queue binding, and signing key");
      await expect(projectWebhookForEvent({ envelope: event, environment: { ...environment, APP_ENV: "production" }, outbox: outbox!, catalog })).rejects.toThrow("local environment");
      await expect(projectWebhookForEvent({ envelope: event, environment: { ...environment, WEBHOOK_SECRET_KEY: "" }, outbox: outbox!, catalog, now: () => now })).rejects.toThrow("signing key is not configured");
      expect((await sql!`select id from webhook_attempt where delivery_id in (select id from webhook_delivery where endpoint_id=${endpoint!.id})`)).toHaveLength(0);
      const states: string[] = [];
      const batch = { messages: [{ body: event, ack: () => states.push("ack"), retry: () => states.push("retry") }] };
      expect(await consumer(batch, environment)).toEqual({ acknowledged: 1, retried: 0 });
      expect(await consumer(batch, environment)).toEqual({ acknowledged: 1, retried: 0 });
      expect(states).toEqual(["ack", "ack"]);
      expect((await sql!`select id from webhook_message where source_event_id=${id}`)).toHaveLength(1);
      expect((await sql!`select id from webhook_delivery where endpoint_id=${endpoint!.id}`)).toHaveLength(1);
      expect((await sql!`select attempt_number, outcome from webhook_attempt where delivery_id in (select id from webhook_delivery where endpoint_id=${endpoint!.id})`)).toEqual([{ attempt_number: 1, outcome: "retry" }]);
      expect(await loadCurrentWebhookSigningSecret({ tenantDatabase, masterKey, environment: "local", organizationId, endpointId: endpoint!.id })).toBe(issued.secret);
      expect(await loadCurrentWebhookSigningSecret({ tenantDatabase, masterKey, environment: "local", organizationId: "another-tenant", endpointId: endpoint!.id })).toBeNull();
      now = new Date(now.getTime() + 1_000);
      expect(await flushDueLocalWebhookDeliveries({ organizationId, tenantDatabase, signingSecretForEndpoint: async (endpointId) =>
        loadCurrentWebhookSigningSecret({ tenantDatabase, masterKey, environment: "local", organizationId, endpointId }),
        scenario: { kind: "fail-times", count: 1, status: 503 }, clock: { now: () => now } })).toEqual({ captured: 1, skipped: 0 });
      expect((await sql!`select attempt_number, outcome from webhook_attempt where delivery_id in (select id from webhook_delivery where endpoint_id=${endpoint!.id}) order by attempt_number`)).toEqual([
        { attempt_number: 1, outcome: "retry" }, { attempt_number: 2, outcome: "succeeded" },
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
      const forged = { ...event, payload: { articleId: "article-1", title: "Forged" } };
      await expect(projectWebhookForEvent({ envelope: forged, environment, outbox: outbox!, catalog })).rejects.toMatchObject({ name: "PermanentEventError", reason: "provenance_mismatch" });
      // An already-verified committed row is still compared, without a second query.
      const committed = await outbox!.findCommitted(id);
      const unqueried = { findCommitted: async () => { throw new Error("The committed row was already loaded"); } };
      await expect(projectWebhookForEvent({ envelope: forged, environment, outbox: unqueried, catalog, committed: committed! })).rejects.toMatchObject({ reason: "provenance_mismatch" });
      // The forged envelope is rejected before the inbox, so it retries into the dead-letter path rather than being acknowledged as a duplicate.
      expect(await consumer({ messages: [{ body: forged, ack: () => states.push("ack"), retry: () => states.push("retry") }] }, environment)).toEqual({ acknowledged: 0, retried: 1 });
      expect(states.at(-1)).toBe("retry");
    } finally { fetchSpy.mockRestore(); }
  });

  it("enqueues only ID wake-ups and safely retries a failed Queue handoff", async () => {
    const organizationId = `native-runtime-${crypto.randomUUID()}`;
    const [endpoint] = await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by) values (${organizationId}, 'preview', 'Native runtime', 'https://example.com/hook', 'active', 'native', 'test-user', 'test-user') returning id`;
    endpointIds.push(endpoint!.id);
    await sql!`insert into webhook_subscription (organization_id, endpoint_id, public_event_type, public_version, created_by) values (${organizationId}, ${endpoint!.id}, 'article.published', 1, 'test-user')`;
    const id = crypto.randomUUID();
    ids.push(id);
    const event = eventEnvelopeSchema.parse({ id, name: "article.published", schemaVersion: 1, occurredAt: new Date().toISOString(), resource: { type: "article", id: "article-2" }, correlationId: id, idempotencyKey: id, payload: { articleId: "article-2", title: "Native" } });
    await outbox!.append(event, { organizationId });
    const environment = { DATABASE_URL: databaseUrl!, DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-only-secret", APP_ENV: "preview" as const, WEBHOOK_DELIVERY_MODE: "native" as const, WEBHOOK_SECRET_KEY: masterKey };
    const sent: unknown[] = [];
    let fail = true;
    const queue = { send: async (work: unknown) => { if (fail) throw new Error("Queue unavailable"); sent.push(work); } };
    const input = { envelope: event, environment, outbox: outbox!, catalog, tenantDatabase: (tenant: string) => createTenantDatabase(databaseUrl!, "postgres-js", tenant), queue };
    await expect(projectWebhookForEvent(input)).rejects.toThrow("Queue unavailable");
    expect((await sql!`select id from webhook_message where source_event_id=${id}`)).toHaveLength(1);
    expect((await sql!`select id from webhook_delivery where endpoint_id=${endpoint!.id}`)).toHaveLength(1);
    fail = false;
    expect(await projectWebhookForEvent(input)).toMatchObject({ state: "ready", deliveries: 1, created: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ sourceEventId: id, deliveryId: (await sql!`select id from webhook_delivery where endpoint_id=${endpoint!.id}`)[0]?.id });
    expect((await sql!`select id from webhook_attempt where delivery_id in (select id from webhook_delivery where endpoint_id=${endpoint!.id})`)).toHaveLength(0);
    const tenantDatabase = (tenant: string) => createTenantDatabase(databaseUrl!, "postgres-js", tenant);
    const secrets = new WebhookSecretService({ tenantDatabase, masterKey, environment: "preview", clock: { now: () => new Date() }, authority: { authorize: async () => ({ actorId: "test-user" }) } });
    await secrets.issue(organizationId, endpoint!.id);
    const actions: string[] = [];
    const message = { body: sent[0], ack: () => actions.push("ack"), retry: ({ delaySeconds }: { delaySeconds?: number } = {}) => actions.push(`retry:${delaySeconds}`) };
    let now = new Date();
    const send = vi.fn(async (request: { destinationUrl: string; body: string; headers: Record<string, string> }) => {
      expect(request.destinationUrl).toBe("https://example.com/hook");
      expect(request.body).toContain("Native");
      expect(request.headers["webhook-signature"]).toMatch(/^v1,/u);
      return { kind: "response" as const, status: send.mock.calls.length === 1 ? 503 : 204, durationMs: 1 };
    });
    const run = (work: Parameters<typeof runNativeWebhookWakeup>[0]) => runNativeWebhookWakeup({ ...work, tenantDatabase, send, clock: { now: () => now } });
    expect(await consumeNativeWebhookQueueMessages({ messages: [message], environment, outbox: outbox!, run })).toEqual({ acknowledged: 0, retried: 1 });
    const [retry] = await sql!<{ next_attempt_at: Date }[]>`select next_attempt_at from webhook_delivery where endpoint_id=${endpoint!.id}`;
    expect(retry?.next_attempt_at).toBeInstanceOf(Date);
    expect(actions[0]).toMatch(/^retry:\d+$/u);
    expect(await consumeNativeWebhookQueueMessages({ messages: [message], environment, outbox: outbox!, run })).toEqual({ acknowledged: 1, retried: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    now = retry!.next_attempt_at;
    expect(await consumeNativeWebhookQueueMessages({ messages: [message], environment, outbox: outbox!, run })).toEqual({ acknowledged: 1, retried: 0 });
    expect(await consumeNativeWebhookQueueMessages({ messages: [message], environment, outbox: outbox!, run })).toEqual({ acknowledged: 1, retried: 0 });
    expect(actions).toEqual([actions[0], "ack", "ack", "ack"]);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await sql!`select kind, outcome, response_status, request_body from webhook_attempt where delivery_id in (select id from webhook_delivery where endpoint_id=${endpoint!.id}) order by attempt_number`)).toEqual([
      { kind: "native", outcome: "retry", response_status: 503, request_body: null },
      { kind: "native", outcome: "succeeded", response_status: 204, request_body: null },
    ]);
  });
});
