import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { createTenantDatabase } from "./index.js";
import { captureLocalWebhookDelivery } from "./webhook-local.js";
import { redactExpiredWebhookPayloads } from "./webhook-retention.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false }) : undefined;
const endpointIds: string[] = [];
const messageIds: string[] = [];
const deliveryIds: string[] = [];
const tenantDatabase = (organizationId: string) => createTenantDatabase(databaseUrl!, "postgres-js", organizationId);
const now = new Date("2026-09-23T12:00:00.000Z");
const cutoffs = { standard: new Date("2026-08-24T12:00:00.000Z"), short: new Date("2026-09-16T12:00:00.000Z") };
const secret = `whsec_${btoa("retention-test-signing-secret-123")}`;

async function fixture(organizationId: string, createdAt: Date, retentionClass: "standard" | "short", leaseUntil?: Date) {
  const [endpoint] = await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by) values (${organizationId}, 'local', 'Retention fixture', 'https://example.test/hook?token=sensitive', 'active', 'local', 'test-user', 'test-user') returning id`;
  if (!endpoint) throw new Error("Could not create endpoint fixture");
  const messageId = `whm_ret_${crypto.randomUUID()}`;
  const deliveryId = `whd_ret_${crypto.randomUUID()}`;
  const body = JSON.stringify({ id: messageId, data: { token: "sensitive" } });
  endpointIds.push(endpoint.id); messageIds.push(messageId); deliveryIds.push(deliveryId);
  await sql!`insert into webhook_message (id, organization_id, source_event_id, public_event_type, public_version, occurred_at, resource_type, resource_id, envelope, payload_size, retention_class, entitlement_decision, status, correlation_id, created_at) values (${messageId}, ${organizationId}, ${crypto.randomUUID()}, 'article.published', 1, ${createdAt}, 'article', 'article-1', ${sql!.json(JSON.parse(body))}, ${body.length}, ${retentionClass}, 'not_required', 'ready', ${crypto.randomUUID()}, ${createdAt})`;
  if (leaseUntil) {
    await sql!`insert into webhook_delivery (id, organization_id, message_id, endpoint_id, state, lease_token, leased_until, next_attempt_at) values (${deliveryId}, ${organizationId}, ${messageId}, ${endpoint.id}, 'leased', ${crypto.randomUUID()}, ${leaseUntil}, ${createdAt})`;
  } else {
    await sql!`insert into webhook_delivery (id, organization_id, message_id, endpoint_id, next_attempt_at) values (${deliveryId}, ${organizationId}, ${messageId}, ${endpoint.id}, ${createdAt})`;
  }
  await sql!`insert into webhook_attempt (id, organization_id, delivery_id, attempt_number, kind, attempted_at, request_url, request_headers, request_body, simulated_status, outcome, duration_ms) values (${`${deliveryId}.1`}, ${organizationId}, ${deliveryId}, 1, 'local', ${createdAt}, 'https://example.test/hook?token=sensitive', ${sql!.json({ 'webhook-signature': 'v1,sensitive' })}, ${body}, 503, 'retry', 2)`;
  return { endpointId: endpoint.id, messageId, deliveryId };
}

const retain = (organizationId: string, limit?: number) => redactExpiredWebhookPayloads({ organizationId, tenantDatabase, clock: { now: () => now }, cutoffs, ...(limit ? { limit } : {}) });

suite("outbound webhook payload retention", () => {
  afterAll(async () => {
    if (deliveryIds.length) await sql!`delete from webhook_attempt where delivery_id = any(${deliveryIds})`;
    if (deliveryIds.length) await sql!`delete from webhook_delivery where id = any(${deliveryIds})`;
    if (messageIds.length) await sql!`delete from webhook_message where id = any(${messageIds})`;
    if (endpointIds.length) await sql!`delete from webhook_endpoint where id = any(${endpointIds})`;
    await sql!.end();
  });

  it("erases expired payload and captured request material while preserving tenant-owned metadata", async () => {
    const expired = await fixture("retention-owner", new Date("2026-08-01T12:00:00.000Z"), "standard");
    const short = await fixture("retention-owner", new Date("2026-09-01T12:00:00.000Z"), "short");
    const retained = await fixture("retention-owner", new Date("2026-09-01T12:00:00.000Z"), "standard");
    const otherTenant = await fixture("retention-other", new Date("2026-08-01T12:00:00.000Z"), "standard");
    expect(await retain("retention-owner")).toEqual({ redacted: 2, skippedActiveLeases: 0, stoppedDeliveries: 2, clearedAttempts: 2 });
    for (const target of [expired, short]) {
      const [message] = await sql!<{ envelope: unknown; payload_size: number; payload_deleted_at: Date; source_event_id: string }[]>`select envelope, payload_size, payload_deleted_at, source_event_id from webhook_message where id=${target.messageId}`;
      expect(message).toMatchObject({ envelope: null, payload_deleted_at: now });
      expect(message?.payload_size).toBeGreaterThan(0);
      expect(message?.source_event_id).toBeTruthy();
      expect((await sql!`select state, terminal_reason, next_attempt_at from webhook_delivery where id=${target.deliveryId}`)[0]).toEqual({ state: "dead", terminal_reason: "payload_expired", next_attempt_at: null });
      expect((await sql!`select request_url, request_headers, request_body, outcome from webhook_attempt where delivery_id=${target.deliveryId}`)[0]).toEqual({ request_url: null, request_headers: {}, request_body: null, outcome: "retry" });
      expect(await captureLocalWebhookDelivery({ organizationId: "retention-owner", deliveryId: target.deliveryId, tenantDatabase, signingSecret: secret, scenario: { kind: "succeed" }, clock: { now: () => now } })).toEqual({ state: "not_due" });
    }
    expect((await sql!`select envelope from webhook_message where id=${retained.messageId}`)[0]?.envelope).not.toBeNull();
    expect((await sql!`select envelope from webhook_message where id=${otherTenant.messageId}`)[0]?.envelope).not.toBeNull();
    expect(await retain("retention-owner")).toEqual({ redacted: 0, skippedActiveLeases: 0, stoppedDeliveries: 0, clearedAttempts: 0 });
  });

  it("waits for a live lease, then fences an expired lease before erasing the payload", async () => {
    const target = await fixture("retention-leased", new Date("2026-08-01T12:00:00.000Z"), "standard", new Date(now.getTime() + 60_000));
    expect(await retain("retention-leased")).toEqual({ redacted: 0, skippedActiveLeases: 1, stoppedDeliveries: 0, clearedAttempts: 0 });
    expect((await sql!`select envelope from webhook_message where id=${target.messageId}`)[0]?.envelope).not.toBeNull();
    await sql!`update webhook_delivery set leased_until=${new Date(now.getTime() - 1)} where id=${target.deliveryId}`;
    expect(await retain("retention-leased")).toEqual({ redacted: 1, skippedActiveLeases: 0, stoppedDeliveries: 1, clearedAttempts: 1 });
    expect((await sql!`select state, lease_token, leased_until from webhook_delivery where id=${target.deliveryId}`)[0]).toEqual({ state: "dead", lease_token: null, leased_until: null });
  });

  it("allows overlapping maintenance runs to redact a message only once", async () => {
    const target = await fixture("retention-concurrent", new Date("2026-08-01T12:00:00.000Z"), "standard");
    const results = await Promise.all([retain("retention-concurrent"), retain("retention-concurrent")]);
    expect(results.reduce((count, result) => count + result.redacted, 0)).toBe(1);
    expect((await sql!`select payload_deleted_at from webhook_message where id=${target.messageId}`)[0]?.payload_deleted_at).toEqual(now);
    expect((await sql!`select id from webhook_attempt where delivery_id=${target.deliveryId}`)).toHaveLength(1);
  });

  it("rejects invalid policy and bound before touching tenant data", async () => {
    await expect(redactExpiredWebhookPayloads({ organizationId: "retention-owner", tenantDatabase, clock: { now: () => now }, cutoffs, limit: 101 })).rejects.toThrow("page size");
    await expect(redactExpiredWebhookPayloads({ organizationId: "retention-owner", tenantDatabase, clock: { now: () => now }, cutoffs: { standard: new Date(NaN), short: cutoffs.short } })).rejects.toThrow("cutoffs");
  });
});
