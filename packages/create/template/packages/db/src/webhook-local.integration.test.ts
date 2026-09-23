import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createTenantDatabase } from "./index.js";
import { captureLocalWebhookDelivery } from "./webhook-local.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false }) : undefined;
const endpointIds: string[] = [];
const messageIds: string[] = [];
const deliveryIds: string[] = [];
const tenantDatabase = (organizationId: string) => createTenantDatabase(databaseUrl!, "postgres-js", organizationId);
const secret = `whsec_${btoa("local-webhook-signing-secret-123")}`;

async function fixture(organizationId: string, environment = "local") {
  const [endpoint] = await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by) values (${organizationId}, ${environment}, 'Local capture', 'https://example.test/hook', 'active', 'local', 'test-user', 'test-user') returning id`;
  if (!endpoint) throw new Error("Endpoint fixture failed");
  const messageId = `whm_test_${crypto.randomUUID()}`;
  const deliveryId = `whd_test_${crypto.randomUUID()}`;
  const envelope = { id: messageId, type: "article.published", version: 1, occurredAt: "2026-09-22T12:00:00.000Z", organizationId, resource: { type: "article", id: "article-1" }, data: { title: "Hello" } };
  endpointIds.push(endpoint.id);
  messageIds.push(messageId);
  deliveryIds.push(deliveryId);
  await sql!`insert into webhook_message (id, organization_id, source_event_id, public_event_type, public_version, occurred_at, resource_type, resource_id, envelope, payload_size, retention_class, entitlement_decision, status, correlation_id) values (${messageId}, ${organizationId}, ${crypto.randomUUID()}, 'article.published', 1, '2026-09-22T12:00:00.000Z', 'article', 'article-1', ${sql!.json(envelope)}, ${JSON.stringify(envelope).length}, 'standard', 'not_required', 'ready', ${crypto.randomUUID()})`;
  await sql!`insert into webhook_delivery (id, organization_id, message_id, endpoint_id, next_attempt_at) values (${deliveryId}, ${organizationId}, ${messageId}, ${endpoint.id}, '2026-09-22T12:00:00.000Z')`;
  return { endpointId: endpoint.id, messageId, deliveryId, envelope };
}

suite("deterministic local outbound webhook capture", () => {
  afterAll(async () => {
    if (deliveryIds.length) await sql!`delete from webhook_attempt where delivery_id = any(${deliveryIds})`;
    if (deliveryIds.length) await sql!`delete from webhook_delivery where id = any(${deliveryIds})`;
    if (messageIds.length) await sql!`delete from webhook_message where id = any(${messageIds})`;
    if (endpointIds.length) await sql!`delete from webhook_endpoint where id = any(${endpointIds})`;
    await sql!.end();
  });

  it("captures a verifiable signed request without network delivery", async () => {
    const { deliveryId, messageId, envelope } = await fixture("local-capture-success");
    const clock = { now: () => new Date("2026-09-22T12:00:01.000Z") };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network access is forbidden in local capture"); });
    try {
      const input = { organizationId: "local-capture-success", deliveryId, tenantDatabase, signingSecret: secret, scenario: { kind: "succeed" as const, latencyMs: 50 }, clock };
      expect(await captureLocalWebhookDelivery(input)).toMatchObject({ state: "succeeded", attemptNumber: 1, nextRetryAt: null });
      expect(await captureLocalWebhookDelivery(input)).toEqual({ state: "not_due" });
      expect(fetchSpy).not.toHaveBeenCalled();
      const [attempt] = await sql!<{ request_body: string; request_headers: Record<string, string>; simulated_status: number; duration_ms: number }[]>`select request_body, request_headers, simulated_status, duration_ms from webhook_attempt where delivery_id=${deliveryId}`;
      expect(JSON.parse(attempt!.request_body)).toEqual(envelope);
      expect(attempt?.request_headers["webhook-id"]).toBe(messageId);
      expect(attempt?.simulated_status).toBe(200);
      expect(attempt?.duration_ms).toBe(50);
      const header = attempt!.request_headers["webhook-signature"];
      if (!header) throw new Error("Missing captured webhook signature");
      const signature = header.replace(/^v1,/, "");
      const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(secret.slice(6)), (character) => character.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      const signed = `${messageId}.${attempt!.request_headers["webhook-timestamp"]}.${attempt!.request_body}`;
      expect(await crypto.subtle.verify("HMAC", key, Uint8Array.from(atob(signature), (character) => character.charCodeAt(0)), new TextEncoder().encode(signed))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("retries against an advanceable clock, then succeeds exactly once", async () => {
    const { deliveryId } = await fixture("local-capture-retry");
    let now = new Date("2026-09-22T12:00:00.000Z");
    const input = { organizationId: "local-capture-retry", deliveryId, tenantDatabase, signingSecret: secret, scenario: { kind: "fail-times" as const, count: 2, status: 503 }, clock: { now: () => now } };
    expect(await captureLocalWebhookDelivery(input)).toMatchObject({ state: "retry", attemptNumber: 1, nextRetryAt: new Date("2026-09-22T12:00:01.000Z") });
    expect(await captureLocalWebhookDelivery(input)).toEqual({ state: "not_due" });
    now = new Date("2026-09-22T12:00:01.000Z");
    expect(await captureLocalWebhookDelivery(input)).toMatchObject({ state: "retry", attemptNumber: 2, nextRetryAt: new Date("2026-09-22T12:00:03.000Z") });
    now = new Date("2026-09-22T12:00:03.000Z");
    expect(await captureLocalWebhookDelivery(input)).toMatchObject({ state: "succeeded", attemptNumber: 3 });
    expect(await captureLocalWebhookDelivery(input)).toEqual({ state: "not_due" });
    const attempts = await sql!`select attempt_number, simulated_status, outcome from webhook_attempt where delivery_id=${deliveryId} order by attempt_number`;
    expect(attempts).toEqual([
      { attempt_number: 1, simulated_status: 503, outcome: "retry" },
      { attempt_number: 2, simulated_status: 503, outcome: "retry" },
      { attempt_number: 3, simulated_status: 200, outcome: "succeeded" },
    ]);
  });

  it("marks 410 terminal and exhausts timeouts without sleeping", async () => {
    const gone = await fixture("local-capture-gone");
    const clock = { now: () => new Date("2026-09-22T12:00:00.000Z") };
    expect(await captureLocalWebhookDelivery({ organizationId: "local-capture-gone", deliveryId: gone.deliveryId, tenantDatabase, signingSecret: secret, scenario: { kind: "fail", status: 410 }, clock })).toMatchObject({ state: "dead", attemptNumber: 1 });
    expect((await sql!`select terminal_reason from webhook_delivery where id=${gone.deliveryId}`)[0]?.terminal_reason).toBe("http_410");
    const timedOut = await fixture("local-capture-timeout");
    let now = clock.now();
    const input = { organizationId: "local-capture-timeout", deliveryId: timedOut.deliveryId, tenantDatabase, signingSecret: secret, scenario: { kind: "timeout" as const }, clock: { now: () => now }, maxAttempts: 2 };
    expect(await captureLocalWebhookDelivery(input)).toMatchObject({ state: "retry", attemptNumber: 1 });
    now = new Date("2026-09-22T12:00:01.000Z");
    expect(await captureLocalWebhookDelivery(input)).toMatchObject({ state: "dead", attemptNumber: 2 });
    expect((await sql!`select simulated_status, duration_ms from webhook_attempt where delivery_id=${timedOut.deliveryId} order by attempt_number`)).toEqual([{ simulated_status: null, duration_ms: 30_000 }, { simulated_status: null, duration_ms: 30_000 }]);
  });

  it("rejects cross-tenant and non-local access and forces attempt RLS", async () => {
    const local = await fixture("local-capture-owner");
    const staging = await fixture("local-capture-staging", "staging");
    const clock = { now: () => new Date("2026-09-22T12:00:00.000Z") };
    expect(await captureLocalWebhookDelivery({ organizationId: "another-tenant", deliveryId: local.deliveryId, tenantDatabase, signingSecret: secret, scenario: { kind: "succeed" }, clock })).toEqual({ state: "not_found" });
    expect(await captureLocalWebhookDelivery({ organizationId: "local-capture-staging", deliveryId: staging.deliveryId, tenantDatabase, signingSecret: secret, scenario: { kind: "succeed" }, clock })).toEqual({ state: "not_local" });
    await captureLocalWebhookDelivery({ organizationId: "local-capture-owner", deliveryId: local.deliveryId, tenantDatabase, signingSecret: secret, scenario: { kind: "succeed" }, clock });
    await sql!.begin(async (transaction) => {
      await transaction`set local role trestle_app`;
      expect(await transaction`select id from webhook_attempt where delivery_id=${local.deliveryId}`).toHaveLength(0);
      await transaction`select set_config('app.organization_id', 'local-capture-owner', true)`;
      expect(await transaction`select id from webhook_attempt where delivery_id=${local.deliveryId}`).toHaveLength(1);
    });
    expect((await sql!`select relforcerowsecurity from pg_class where relname='webhook_attempt'`)[0]?.relforcerowsecurity).toBe(true);
  });

  it("allows only one capture when the same delivery is claimed concurrently", async () => {
    const { deliveryId } = await fixture("local-capture-concurrent");
    const input = { organizationId: "local-capture-concurrent", deliveryId, tenantDatabase, signingSecret: secret, scenario: { kind: "succeed" as const }, clock: { now: () => new Date("2026-09-22T12:00:00.000Z") } };
    const results = await Promise.all([captureLocalWebhookDelivery(input), captureLocalWebhookDelivery(input)]);
    expect(results.map((result) => result.state).sort()).toEqual(["not_due", "succeeded"]);
    expect((await sql!`select id from webhook_attempt where delivery_id=${deliveryId}`)).toHaveLength(1);
  });

  it("rejects invalid local configuration before recording an attempt", async () => {
    const { deliveryId } = await fixture("local-capture-invalid");
    const base = { organizationId: "local-capture-invalid", deliveryId, tenantDatabase, clock: { now: () => new Date("2026-09-22T12:00:00.000Z") } };
    await expect(captureLocalWebhookDelivery({ ...base, signingSecret: "short", scenario: { kind: "succeed" } })).rejects.toThrow("signing secret");
    await expect(captureLocalWebhookDelivery({ ...base, signingSecret: secret, scenario: { kind: "fail", status: 200 } })).rejects.toThrow("Failure scenario");
    await expect(captureLocalWebhookDelivery({ ...base, signingSecret: secret, scenario: { kind: "succeed" }, maxAttempts: 0 })).rejects.toThrow("maximum attempt");
    expect((await sql!`select id from webhook_attempt where delivery_id=${deliveryId}`)).toHaveLength(0);
  });
});
