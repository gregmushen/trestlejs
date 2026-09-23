import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listAuditEvents } from "./audit.js";
import { createPlatformDatabase, createTenantDatabase } from "./index.js";
import { artifactOperations, disableWebhookEndpoint, listDeadOutboxEvents, listFailedWebhookDeliveries, listPlatformWebhookEndpoints, PlatformOperationError, redriveOutboxEvent, replayWebhookDelivery } from "./platform-operations.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `ops${Date.now()}`;
const organizationId = `${run}-org`;
const correlationId = `${run}-corr`;
const context = (reason = "customer ticket 42") => ({ actor: { type: "platform_operator" as const, id: `${run}-operator` }, reason, environment: "local", correlationId });
const ids = { outbox: crypto.randomUUID(), live: crypto.randomUUID(), endpoint: "", dead: `${run}-dead`, purged: `${run}-purged`, succeeded: `${run}-ok` };

async function asPlatform<T>(work: (transaction: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return await sql!.begin(async (transaction) => {
    await transaction.unsafe("set local role trestle_platform");
    return await work(transaction);
  }) as T;
}

async function failure(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) { return `${(error as Error).message} ${((error as { cause?: Error }).cause?.message ?? "")}`; }
  return "resolved";
}

suite("platform operations on the trestle_platform connection", () => {
  beforeAll(async () => {
    for (const [id, status] of [[ids.outbox, "dead"], [ids.live, "pending"]] as const) {
      await sql!`insert into outbox_message (id, event_name, schema_version, occurred_at, resource_type, resource_id, organization_id, correlation_id, idempotency_key, payload, status, attempts, last_error, available_at)
        values (${id}, 'article.published', 1, now(), 'article', 'a1', ${organizationId}, ${correlationId}, ${`${run}-${id}`}, ${sql!.json({ secret: "payload" })}, ${status}, 5, 'timeout', now())`;
    }
    const [endpoint] = await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by)
      values (${organizationId}, 'preview', 'Ops hook', 'https://customer.example/hook', 'active', 'native', 'owner', 'owner') returning id`;
    ids.endpoint = endpoint!.id;
    for (const [delivery, state, payloadDeleted] of [[ids.dead, "exhausted", false], [ids.purged, "dead", true], [ids.succeeded, "succeeded", false]] as const) {
      await sql!`insert into webhook_message (id, organization_id, source_event_id, public_event_type, public_version, occurred_at, resource_type, resource_id, envelope, payload_size, retention_class, entitlement_decision, status, correlation_id, payload_deleted_at)
        values (${`${delivery}-m`}, ${organizationId}, ${crypto.randomUUID()}, 'article.published', 1, now(), 'article', 'a1', ${sql!.json({ secret: "envelope" })}, 20, 'standard', 'not_required', 'ready', ${correlationId}, ${payloadDeleted ? new Date() : null})`;
      await sql!`insert into webhook_delivery (id, organization_id, message_id, endpoint_id, state, attempt_count, terminal_reason, completed_at)
        values (${delivery}, ${organizationId}, ${`${delivery}-m`}, ${ids.endpoint}, ${state}, 7, ${state === "succeeded" ? null : "retry_exhausted:http_500"}, now())`;
    }
    await sql!`insert into artifact_metadata (id, organization_id, storage_key, content_type, size, upload_state, created_at) values (${`${run}-art`}, ${organizationId}, 'org/secret-key', 'text/plain', 10, 'pending', now() - interval '2 days')`;
  });

  afterAll(async () => {
    await sql!`delete from audit_event where correlation_id = ${correlationId}`;
    await sql!`delete from artifact_metadata where organization_id = ${organizationId}`;
    await sql!`delete from webhook_delivery where organization_id = ${organizationId}`;
    await sql!`delete from webhook_message where organization_id = ${organizationId}`;
    await sql!`delete from webhook_endpoint where organization_id = ${organizationId}`;
    await sql!`delete from outbox_message where organization_id = ${organizationId}`;
    await sql!.end();
  });

  it("reads operational metadata but never payloads, envelopes, destinations, lease tokens, or storage keys", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    expect((await listDeadOutboxEvents(platform, { limit: 100 })).map(({ id }) => id)).toContain(ids.outbox);
    expect((await listPlatformWebhookEndpoints(platform, { limit: 100 })).find(({ id }) => id === ids.endpoint)).toMatchObject({ organizationId, state: "active" });
    const failed = await listFailedWebhookDeliveries(platform, { limit: 100 });
    expect(failed.find(({ id }) => id === ids.dead)).toMatchObject({ state: "exhausted", replayable: true, eventType: "article.published" });
    expect(failed.find(({ id }) => id === ids.purged)).toMatchObject({ replayable: false });
    expect(failed.map(({ id }) => id)).not.toContain(ids.succeeded);
    expect((await artifactOperations(platform, { staleBefore: new Date(Date.now() - 86_400_000) })).stalePending).toBeGreaterThanOrEqual(1);
    for (const statement of ["select payload from outbox_message limit 1", "select envelope from webhook_message limit 1", "select destination_url from webhook_endpoint limit 1",
      "select lease_token from webhook_delivery limit 1", "select storage_key from artifact_metadata limit 1", "select id from webhook_secret_version limit 1", "select id from webhook_attempt limit 1"]) {
      expect(await failure(asPlatform(async (transaction) => await transaction.unsafe(statement))), statement).toMatch(/permission denied/u);
    }
  });

  it("allows only the audited recovery transitions, enforced by PostgreSQL", async () => {
    expect(await failure(asPlatform(async (transaction) => await transaction`update webhook_endpoint set state = 'active' where id = ${ids.endpoint}`))).toMatch(/row-level security/u);
    expect(await failure(asPlatform(async (transaction) => await transaction`update webhook_delivery set state = 'succeeded' where id = ${ids.dead}`))).toMatch(/row-level security/u);
    expect((await asPlatform(async (transaction) => await transaction`update webhook_delivery set state = 'retry' where id = ${ids.succeeded}`)).count).toBe(0);
    expect(await failure(asPlatform(async (transaction) => await transaction`update outbox_message set payload = '{}' where id = ${ids.outbox}`))).toMatch(/permission denied/u);
    expect(await failure(asPlatform(async (transaction) => await transaction`delete from webhook_delivery where id = ${ids.dead}`))).toMatch(/permission denied/u);
  });

  it("redrives, disables, and replays with a reason and a redacted audit record in the same transaction", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    await expect(redriveOutboxEvent(platform, ids.outbox, context(" "))).rejects.toBeInstanceOf(PlatformOperationError);
    await redriveOutboxEvent(platform, ids.outbox, context());
    await expect(redriveOutboxEvent(platform, ids.live, context())).rejects.toThrow("not dead-lettered");
    await disableWebhookEndpoint(platform, { organizationId, endpointId: ids.endpoint }, context("abusive destination"));
    await expect(disableWebhookEndpoint(platform, { organizationId, endpointId: ids.endpoint }, context())).rejects.toThrow("already disabled");
    await replayWebhookDelivery(platform, { organizationId, deliveryId: ids.dead }, context("receiver fixed"));
    await expect(replayWebhookDelivery(platform, { organizationId, deliveryId: ids.purged }, context())).rejects.toThrow("no longer retained");
    await expect(replayWebhookDelivery(platform, { organizationId: "another-org", deliveryId: ids.dead }, context())).rejects.toThrow("does not exist");

    const [outbox] = await sql!`select status, last_error from outbox_message where id = ${ids.outbox}`;
    expect(outbox).toEqual({ status: "pending", last_error: null });
    const [endpoint] = await sql!`select state, updated_by from webhook_endpoint where id = ${ids.endpoint}`;
    expect(endpoint).toEqual({ state: "disabled", updated_by: `platform_operator:${run}-operator` });
    const [delivery] = await sql!`select state, attempt_count, terminal_reason, completed_at, next_attempt_at <= now() as due from webhook_delivery where id = ${ids.dead}`;
    expect(delivery).toEqual({ state: "retry", attempt_count: 7, terminal_reason: null, completed_at: null, due: true });

    const events = await sql!`select name, actor_type, actor_id, organization_id, target_type, reason, summary from audit_event where correlation_id = ${correlationId} order by occurred_at, name`;
    expect(events.map((event) => event.name)).toEqual(["platform.outbox_event.redriven", "platform.webhook_endpoint.disabled", "platform.webhook_delivery.replayed"]);
    expect(events.every((event) => event.actor_type === "platform_operator" && event.organization_id === organizationId)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/customer\.example|payload|envelope/u);

    // The organization sees that the platform acted, but not who or the internal reason.
    const tenantEvents = await listAuditEvents(createTenantDatabase(connectionString!, "postgres-js", organizationId), organizationId);
    const replay = tenantEvents.find((event) => event.name === "platform.webhook_delivery.replayed");
    expect(replay).toMatchObject({ actorType: "platform_operator", actorId: "platform", reason: null, correlationId });
  });
});
