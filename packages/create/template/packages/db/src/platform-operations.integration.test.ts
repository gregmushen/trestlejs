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
const ids = { outbox: crypto.randomUUID(), live: crypto.randomUUID(), endpoint: "", dead: `${run}-dead`, concurrent: `${run}-concurrent`, purged: `${run}-purged`, succeeded: `${run}-ok`, old: `${run}-old`, orphan: `${run}-orphan` };

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
    // Each message's committed outbox row is its replay provenance: `old` is
    // outside the 14-day replay window and `orphan`'s row was pruned.
    for (const [delivery, state, payloadDeleted, provenance] of [[ids.dead, "exhausted", false, "fresh"], [ids.concurrent, "dead", false, "fresh"], [ids.purged, "dead", true, "fresh"], [ids.succeeded, "succeeded", false, "fresh"], [ids.old, "dead", false, "old"], [ids.orphan, "dead", false, "missing"]] as const) {
      const sourceEventId = crypto.randomUUID();
      if (provenance !== "missing") {
        await sql!`insert into outbox_message (id, event_name, schema_version, occurred_at, resource_type, resource_id, organization_id, correlation_id, idempotency_key, payload, status, attempts, available_at, processed_at)
          values (${sourceEventId}, 'article.published', 1, now() - ${provenance === "old" ? "15 days" : "0 days"}::interval, 'article', 'a1', ${organizationId}, ${correlationId}, ${`${run}-${sourceEventId}`}, ${sql!.json({})}, 'succeeded', 1, now(), now())`;
      }
      await sql!`insert into webhook_message (id, organization_id, source_event_id, public_event_type, public_version, occurred_at, resource_type, resource_id, envelope, payload_size, retention_class, entitlement_decision, status, correlation_id, payload_deleted_at)
        values (${`${delivery}-m`}, ${organizationId}, ${sourceEventId}, 'article.published', 1, now(), 'article', 'a1', ${sql!.json({ secret: "envelope" })}, 20, 'standard', 'not_required', 'ready', ${correlationId}, ${payloadDeleted ? new Date() : null})`;
      await sql!`insert into webhook_delivery (id, organization_id, message_id, endpoint_id, state, attempt_count, terminal_reason, completed_at)
        values (${delivery}, ${organizationId}, ${`${delivery}-m`}, ${ids.endpoint}, ${state}, 7, ${state === "succeeded" ? null : "retry_exhausted:http_500"}, now())`;
    }
    await sql!`insert into artifact_metadata (id, organization_id, storage_key, content_type, size, upload_state, created_at) values (${`${run}-art`}, ${organizationId}, 'org/secret-key', 'text/plain', 10, 'pending', now() - interval '2 days')`;
  });

  afterAll(async () => {
    await sql!`delete from audit_event where correlation_id in (${correlationId}, ${`${correlationId}-concurrent`})`;
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
    // A non-numeric page size falls back to the default instead of reaching SQL.
    expect(Array.isArray(await listDeadOutboxEvents(platform, { limit: Number("abc") }))).toBe(true);
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
    expect(await failure(asPlatform(async (transaction) => await transaction`update webhook_delivery set state = 'succeeded' where id = ${ids.dead}`))).toMatch(/permission denied/u);
    expect(await failure(asPlatform(async (transaction) => await transaction`update webhook_delivery set state = 'retry' where id = ${ids.succeeded}`))).toMatch(/permission denied/u);
    expect(await failure(asPlatform(async (transaction) => await transaction`update outbox_message set payload = '{}' where id = ${ids.outbox}`))).toMatch(/permission denied/u);
    expect(await failure(asPlatform(async (transaction) => await transaction`delete from webhook_delivery where id = ${ids.dead}`))).toMatch(/permission denied/u);
    expect(await failure(asPlatform(async (transaction) => await transaction`insert into webhook_delivery (id, organization_id, message_id, endpoint_id) values ('forged', ${organizationId}, ${`${ids.dead}-m`}, ${ids.endpoint})`))).toMatch(/permission denied/u);
    expect(await failure(sql!.begin(async (transaction) => {
      await transaction.unsafe("set local role trestle_app");
      return transaction`select * from trestle_replay_webhook_delivery(${organizationId}, ${ids.dead}, now(), 'platform_operator', 'operator', 'reason', 'local', 'corr')`;
    }))).toMatch(/permission denied/u);
  });

  it("serializes concurrent platform replays into one new execution", async () => {
    const concurrentContext = { ...context("receiver recovered"), correlationId: `${correlationId}-concurrent` };
    const [first, second] = await Promise.all([
      replayWebhookDelivery(createPlatformDatabase(connectionString!, "postgres-js"), { organizationId, deliveryId: ids.concurrent }, concurrentContext),
      replayWebhookDelivery(createPlatformDatabase(connectionString!, "postgres-js"), { organizationId, deliveryId: ids.concurrent }, concurrentContext),
    ]);
    expect(first.deliveryId).toBe(second.deliveryId);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    const rows = await sql!`select id, replay_of_delivery_id, state, attempt_count from webhook_delivery where replay_of_delivery_id = ${ids.concurrent}`;
    expect(rows).toEqual([{ id: first.deliveryId, replay_of_delivery_id: ids.concurrent, state: "pending", attempt_count: 0 }]);
    const audits = await sql!`select target_id from audit_event where name = 'platform.webhook_delivery.replayed' and target_id = ${first.deliveryId}`;
    expect(audits).toHaveLength(1);
    await sql!`update webhook_delivery set state = 'succeeded', next_attempt_at = null, completed_at = now() where id = ${first.deliveryId}`;
    expect((await listFailedWebhookDeliveries(createPlatformDatabase(connectionString!, "postgres-js"))).find(({ id }) => id === ids.concurrent)).toMatchObject({ replayable: false, successfulReplayId: first.deliveryId, replayUnavailableReason: "resolved" });
    await expect(replayWebhookDelivery(createPlatformDatabase(connectionString!, "postgres-js"), { organizationId, deliveryId: ids.concurrent }, concurrentContext)).rejects.toThrow("already succeeded");
    expect(await sql!`select id from webhook_delivery where replay_of_delivery_id = ${ids.concurrent}`).toHaveLength(1);
  });

  it("refuses a platform replay once the source event is outside the 14-day replay window or no longer retained", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    for (const deliveryId of [ids.old, ids.orphan]) {
      const error = await replayWebhookDelivery(platform, { organizationId, deliveryId }, context()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PlatformOperationError);
      expect(error).toMatchObject({ code: "conflict", message: "The source event is outside the 14-day replay window or no longer retained, so the delivery cannot be replayed" });
    }
    expect(await sql!`select id from webhook_delivery where replay_of_delivery_id in (${ids.old}, ${ids.orphan})`).toEqual([]);
    expect(await sql!`select id from audit_event where name = 'platform.webhook_delivery.replayed' and summary->>'sourceDeliveryId' in (${ids.old}, ${ids.orphan})`).toEqual([]);
  });

  it("redrives, disables, and replays with a reason and a redacted audit record in the same transaction", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    await expect(redriveOutboxEvent(platform, ids.outbox, context(" "))).rejects.toBeInstanceOf(PlatformOperationError);
    await redriveOutboxEvent(platform, ids.outbox, context());
    await expect(redriveOutboxEvent(platform, ids.live, context())).rejects.toThrow("not dead-lettered");
    const replay = await replayWebhookDelivery(platform, { organizationId, deliveryId: ids.dead }, context("receiver fixed"));
    expect(replay).toMatchObject({ created: true });
    expect(replay.deliveryId).not.toBe(ids.dead);
    expect(await replayWebhookDelivery(platform, { organizationId, deliveryId: ids.dead }, context("receiver fixed"))).toEqual({ deliveryId: replay.deliveryId, created: false });
    await expect(replayWebhookDelivery(platform, { organizationId, deliveryId: ids.purged }, context())).rejects.toThrow("no longer retained");
    await expect(replayWebhookDelivery(platform, { organizationId: "another-org", deliveryId: ids.dead }, context())).rejects.toThrow("does not exist");
    await expect(replayWebhookDelivery(platform, { organizationId, deliveryId: ids.succeeded }, context())).rejects.toThrow("cannot be replayed");
    expect((await listFailedWebhookDeliveries(platform)).find(({ id }) => id === ids.dead)).toMatchObject({ replayable: false, activeReplayId: replay.deliveryId, replayUnavailableReason: "replay_pending" });
    await disableWebhookEndpoint(platform, { organizationId, endpointId: ids.endpoint }, context("abusive destination"));
    await expect(disableWebhookEndpoint(platform, { organizationId, endpointId: ids.endpoint }, context())).rejects.toThrow("already disabled");
    await expect(replayWebhookDelivery(platform, { organizationId, deliveryId: ids.purged }, context())).rejects.toThrow("no longer retained");

    const [outbox] = await sql!`select status, last_error from outbox_message where id = ${ids.outbox}`;
    expect(outbox).toEqual({ status: "pending", last_error: null });
    const [endpoint] = await sql!`select state, updated_by from webhook_endpoint where id = ${ids.endpoint}`;
    expect(endpoint).toEqual({ state: "disabled", updated_by: `platform_operator:${run}-operator` });
    const [delivery] = await sql!`select state, attempt_count, terminal_reason, completed_at, next_attempt_at from webhook_delivery where id = ${ids.dead}`;
    expect(delivery).toMatchObject({ state: "exhausted", attempt_count: 7, terminal_reason: "retry_exhausted:http_500" });
    expect(delivery?.completed_at).toBeInstanceOf(Date);
    expect(delivery?.next_attempt_at).toBeNull();
    const [replayed] = await sql!`select state, attempt_count, replay_of_delivery_id, message_id, endpoint_id, next_attempt_at <= now() as due from webhook_delivery where id = ${replay.deliveryId}`;
    expect(replayed).toEqual({ state: "pending", attempt_count: 0, replay_of_delivery_id: ids.dead, message_id: `${ids.dead}-m`, endpoint_id: ids.endpoint, due: true });

    const events = await sql!`select name, actor_type, actor_id, organization_id, target_type, reason, summary from audit_event where correlation_id = ${correlationId} order by occurred_at, name`;
    expect(events.map((event) => event.name)).toEqual(["platform.outbox_event.redriven", "platform.webhook_delivery.replayed", "platform.webhook_endpoint.disabled"]);
    expect(events.every((event) => event.actor_type === "platform_operator" && event.organization_id === organizationId)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/customer\.example|payload|envelope/u);

    // The organization sees that the platform acted, but not who or the internal reason.
    const tenantEvents = await listAuditEvents(createTenantDatabase(connectionString!, "postgres-js", organizationId), organizationId);
    const replayEvent = tenantEvents.find((event) => event.name === "platform.webhook_delivery.replayed");
    expect(replayEvent).toMatchObject({ actorType: "platform_operator", actorId: "platform", reason: null, correlationId });
  });
});
