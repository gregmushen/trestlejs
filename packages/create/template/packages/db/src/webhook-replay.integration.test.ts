import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";

import { listAuditEvents } from "./audit.js";
import { createTenantDatabase } from "./index.js";
import { captureLocalWebhookDelivery } from "./webhook-local.js";
import { listWebhookAttempts, listWebhookDeliveries } from "./webhook-inspection.js";
import { replayTenantWebhookDelivery } from "./webhook-replay.js";
import { createSignedWebhookHeaders } from "./webhook-signing.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false }) : undefined;
const run = `customer-replay-${crypto.randomUUID()}`;
const tenantDatabase = (organizationId: string) => createTenantDatabase(databaseUrl!, "postgres-js", organizationId);
const now = new Date();
const secret = `whsec_${btoa("local-customer-replay-signing-secret")}`;
const endpoints: string[] = [];
const messages: string[] = [];
const deliveries: string[] = [];
const sourceEvents: string[] = [];
const day = 86_400_000;

async function fixture(suffix: string, options: { organizationId?: string; expired?: boolean; endpointState?: "active" | "disabled"; deliveryState?: "dead" | "succeeded"; provenance?: "fresh" | "boundary" | "old" | "missing" } = {}) {
  const organizationId = options.organizationId ?? `${run}-${suffix}`;
  const [endpoint] = await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by)
    values (${organizationId}, 'local', 'Replay test', 'https://example.test/hook?private=secret', ${options.endpointState ?? "active"}, 'local', 'owner', 'owner') returning id`;
  const messageId = `whm_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
  const deliveryId = `whd_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
  const envelope = { id: messageId, type: "article.published", version: 1, occurredAt: now.toISOString(), organizationId, resource: { type: "article", id: suffix }, data: { private: "never-inspect-this-payload" } };
  const sourceEventId = crypto.randomUUID();
  endpoints.push(endpoint!.id); messages.push(messageId); deliveries.push(deliveryId); sourceEvents.push(sourceEventId);
  // The committed outbox row is the provenance a replayed delivery verifies against.
  const provenance = options.provenance ?? "fresh";
  if (provenance !== "missing") {
    const occurredAt = new Date(now.getTime() - (provenance === "old" ? 14 * day + 60_000 : provenance === "boundary" ? 14 * day : 0));
    await sql!`insert into outbox_message (id, event_name, schema_version, occurred_at, resource_type, resource_id, organization_id, correlation_id, idempotency_key, payload, status, attempts, available_at, processed_at)
      values (${sourceEventId}, 'article.published', 1, ${occurredAt}, 'article', ${suffix}, ${organizationId}, ${run}, ${sourceEventId}, ${sql!.json({})}, 'succeeded', 1, ${occurredAt}, ${occurredAt})`;
  }
  await sql!`insert into webhook_message (id, organization_id, source_event_id, public_event_type, public_version, occurred_at, resource_type, resource_id, envelope, payload_size, retention_class, entitlement_decision, status, correlation_id, payload_deleted_at)
    values (${messageId}, ${organizationId}, ${sourceEventId}, 'article.published', 1, ${now}, 'article', ${suffix}, ${options.expired ? null : sql!.json(envelope)}, ${JSON.stringify(envelope).length}, 'standard', 'not_required', 'ready', ${run}, ${options.expired ? now : null})`;
  await sql!`insert into webhook_delivery (id, organization_id, message_id, endpoint_id, state, attempt_count, terminal_reason, completed_at)
    values (${deliveryId}, ${organizationId}, ${messageId}, ${endpoint!.id}, ${options.deliveryState ?? "dead"}, 2, ${options.deliveryState === "succeeded" ? null : "http_500"}, ${now})`;
  for (const attemptNumber of [1, 2]) await sql!`insert into webhook_attempt (id, organization_id, delivery_id, attempt_number, kind, attempted_at, completed_at, request_headers, response_status, result_category, outcome, duration_ms)
    values (${`wha_${crypto.randomUUID()}`}, ${organizationId}, ${deliveryId}, ${attemptNumber}, 'local', ${now}, ${now}, ${sql!.json({})}, ${options.deliveryState === "succeeded" ? 200 : 500}, 'http', ${options.deliveryState === "succeeded" ? "succeeded" : "dead"}, 1)`;
  return { organizationId, endpointId: endpoint!.id, messageId, deliveryId };
}

function request(input: { organizationId: string; deliveryId: string }) {
  return { ...input, environment: "local" as const, actorId: "owner-1", correlationId: run, database: tenantDatabase(input.organizationId), now };
}

suite("customer webhook replay under forced tenant RLS", () => {
  afterAll(async () => {
    await sql!`delete from audit_event where correlation_id = ${run}`;
    if (deliveries.length) await sql!`delete from webhook_attempt where delivery_id in (select id from webhook_delivery where id = any(${deliveries}) or replay_of_delivery_id = any(${deliveries}))`;
    if (deliveries.length) await sql!`delete from webhook_delivery where replay_of_delivery_id = any(${deliveries})`;
    if (deliveries.length) await sql!`delete from webhook_delivery where id = any(${deliveries})`;
    if (messages.length) await sql!`delete from webhook_message where id = any(${messages})`;
    if (endpoints.length) await sql!`delete from webhook_endpoint where id = any(${endpoints})`;
    if (sourceEvents.length) await sql!`delete from outbox_message where id = any(${sourceEvents})`;
    await sql!.end();
  });

  it("creates one linked execution, signs a local attempt, and never alters the original", async () => {
    const source = await fixture("main");
    expect(await replayTenantWebhookDelivery({ ...request(source), organizationId: `${run}-other` })).toEqual({ state: "not_found" });
    expect(await replayTenantWebhookDelivery({ ...request(source), environment: "preview" })).toEqual({ state: "not_found" });
    const [first, second] = await Promise.all([
      replayTenantWebhookDelivery(request(source)),
      replayTenantWebhookDelivery(request(source)),
    ]);
    expect(first.state === "created" || second.state === "created").toBe(true);
    expect(first.state === "existing" || second.state === "existing").toBe(true);
    if (!("deliveryId" in first) || !("deliveryId" in second)) throw new Error("Replay was not queued");
    expect(first.deliveryId).toBe(second.deliveryId);
    const [original] = await sql!`select state, attempt_count, terminal_reason from webhook_delivery where id=${source.deliveryId}`;
    expect(original).toEqual({ state: "dead", attempt_count: 2, terminal_reason: "http_500" });
    expect((await sql!`select attempt_number from webhook_attempt where delivery_id=${source.deliveryId} order by attempt_number`).map((attempt) => attempt.attempt_number)).toEqual([1, 2]);
    const [replayed] = await sql!`select state, attempt_count, replay_of_delivery_id, message_id from webhook_delivery where id=${first.deliveryId}`;
    expect(replayed).toEqual({ state: "pending", attempt_count: 0, replay_of_delivery_id: source.deliveryId, message_id: source.messageId });
    const audit = await listAuditEvents(tenantDatabase(source.organizationId), source.organizationId);
    expect(audit.filter((item) => item.name === "webhooks.delivery.replayed")).toEqual([expect.objectContaining({ actorType: "user", actorId: "owner-1", targetId: first.deliveryId, correlationId: run })]);
    expect(JSON.stringify(audit)).not.toMatch(/never-inspect-this-payload|private=secret|whsec_/u);
    expect((await listWebhookDeliveries({ ...source, environment: "local", tenantDatabase, deliveryMode: "local" })).find((item) => item.id === source.deliveryId)).toMatchObject({ replayable: false, activeReplayId: first.deliveryId, replayUnavailableReason: "replay_pending" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Local replay must not use the network"); });
    try {
      expect(await captureLocalWebhookDelivery({ organizationId: source.organizationId, deliveryId: first.deliveryId, tenantDatabase, signingSecret: secret, scenario: { kind: "succeed" }, clock: { now: () => now } })).toMatchObject({ state: "succeeded", attemptNumber: 1 });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
    const [signedAttempt] = await sql!`select request_body, request_headers from webhook_attempt where delivery_id=${first.deliveryId}`;
    expect(signedAttempt?.request_headers).toMatchObject(await createSignedWebhookHeaders({ secret, messageId: source.messageId, body: String(signedAttempt?.request_body), now }));
    expect(await listWebhookAttempts({ organizationId: source.organizationId, environment: "local", deliveryId: first.deliveryId, tenantDatabase })).toEqual([expect.objectContaining({ attemptNumber: 1, outcome: "succeeded" })]);
    expect((await listWebhookDeliveries({ ...source, environment: "local", tenantDatabase, deliveryMode: "local" })).find((item) => item.id === source.deliveryId)).toMatchObject({ replayable: false, successfulReplayId: first.deliveryId, replayUnavailableReason: "resolved" });
    expect(await replayTenantWebhookDelivery(request(source))).toEqual({ state: "already_succeeded" });
    expect((await sql!`select id from webhook_delivery where replay_of_delivery_id=${source.deliveryId}`)).toHaveLength(1);
    expect((await sql!`select attempt_number from webhook_attempt where delivery_id=${source.deliveryId} order by attempt_number`).map((attempt) => attempt.attempt_number)).toEqual([1, 2]);
  });

  it("rejects non-failed, expired, and inactive deliveries without an audit row", async () => {
    const succeeded = await fixture("succeeded", { deliveryState: "succeeded" });
    const expired = await fixture("expired", { expired: true });
    const inactive = await fixture("inactive", { endpointState: "disabled" });
    expect(await replayTenantWebhookDelivery(request(succeeded))).toEqual({ state: "not_terminal" });
    expect(await replayTenantWebhookDelivery(request(expired))).toEqual({ state: "payload_gone" });
    expect(await replayTenantWebhookDelivery(request(inactive))).toEqual({ state: "endpoint_inactive" });
    expect((await sql!`select id from webhook_delivery where replay_of_delivery_id in (${succeeded.deliveryId}, ${expired.deliveryId}, ${inactive.deliveryId})`)).toEqual([]);
  });

  it("refuses a replay once the source event is outside the 14-day replay window or no longer retained", async () => {
    const old = await fixture("old-provenance", { provenance: "old" });
    const missing = await fixture("missing-provenance", { provenance: "missing" });
    const boundary = await fixture("boundary-provenance", { provenance: "boundary" });
    expect(await replayTenantWebhookDelivery(request(old))).toEqual({ state: "provenance_expired" });
    expect(await replayTenantWebhookDelivery(request(missing))).toEqual({ state: "provenance_expired" });
    // Exactly 14 days old is still inside the window.
    expect(await replayTenantWebhookDelivery(request(boundary))).toMatchObject({ state: "created" });
    // Provenance of another tenant never counts as this delivery's provenance.
    const foreign = await fixture("foreign-provenance");
    await sql!`update outbox_message set organization_id = ${`${run}-someone-else`} where id = (select source_event_id::text from webhook_message where id = ${foreign.messageId})`;
    expect(await replayTenantWebhookDelivery(request(foreign))).toEqual({ state: "provenance_expired" });
    expect((await sql!`select id from webhook_delivery where replay_of_delivery_id in (${old.deliveryId}, ${missing.deliveryId}, ${foreign.deliveryId})`)).toEqual([]);
    expect((await sql!`select id from audit_event where correlation_id = ${run} and summary->>'sourceDeliveryId' in (${old.deliveryId}, ${missing.deliveryId}, ${foreign.deliveryId})`)).toEqual([]);
  });
});
