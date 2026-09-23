import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { createTenantDatabase } from "./index.js";
import { listWebhookAttempts, listWebhookDeliveries, listWebhookEndpoints, listWebhookSubscriptions } from "./webhook-inspection.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false }) : undefined;
const tenantDatabase = (organizationId: string) => createTenantDatabase(databaseUrl!, "postgres-js", organizationId);
const endpointIds: string[] = [];
const messageIds: string[] = [];
const deliveryIds: string[] = [];
const sensitive = "never-return-this-token";

async function fixture(organizationId: string) {
  const [endpoint] = await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by) values (${organizationId}, 'preview', 'Inspection fixture', ${`https://api.example.com/private/${sensitive}?token=${sensitive}`}, 'active', 'native', 'test-user', 'test-user') returning id`;
  if (!endpoint) throw new Error("Endpoint fixture failed");
  const messageId = `whm_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
  const deliveryId = `whd_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
  endpointIds.push(endpoint.id); messageIds.push(messageId); deliveryIds.push(deliveryId);
  await sql!`insert into webhook_subscription (organization_id, endpoint_id, public_event_type, public_version, created_by) values (${organizationId}, ${endpoint.id}, 'article.published', 1, 'test-user')`;
  await sql!`insert into webhook_message (id, organization_id, source_event_id, public_event_type, public_version, occurred_at, resource_type, resource_id, envelope, payload_size, retention_class, entitlement_decision, status, correlation_id) values (${messageId}, ${organizationId}, ${crypto.randomUUID()}, 'article.published', 1, now(), 'article', 'article-1', ${sql!.json({ token: sensitive })}, 20, 'standard', 'not_required', 'ready', ${crypto.randomUUID()})`;
  await sql!`insert into webhook_delivery (id, organization_id, message_id, endpoint_id, next_attempt_at) values (${deliveryId}, ${organizationId}, ${messageId}, ${endpoint.id}, now())`;
  await sql!`insert into webhook_attempt (id, organization_id, delivery_id, attempt_number, kind, attempted_at, request_url, request_headers, request_body, outcome, duration_ms, result_category, response_status) values (${`${deliveryId}.1`}, ${organizationId}, ${deliveryId}, 1, 'local', now(), ${`https://api.example.com/${sensitive}`}, ${sql!.json({ 'webhook-signature': sensitive })}, ${sensitive}, 'retry', 8, 'http', 503)`;
  return { endpointId: endpoint.id, messageId, deliveryId };
}

suite("tenant-safe outbound webhook inspection", () => {
  afterAll(async () => {
    if (deliveryIds.length) await sql!`delete from webhook_attempt where delivery_id = any(${deliveryIds})`;
    if (deliveryIds.length) await sql!`delete from webhook_delivery where id = any(${deliveryIds})`;
    if (messageIds.length) await sql!`delete from webhook_message where id = any(${messageIds})`;
    if (endpointIds.length) await sql!`delete from webhook_endpoint where id = any(${endpointIds})`;
    await sql!.end();
  });

  it("returns only safe metadata under forced tenant RLS and current environment", async () => {
    const own = await fixture("inspection-owner");
    const other = await fixture("inspection-other");
    const endpoints = await listWebhookEndpoints({ organizationId: "inspection-owner", environment: "preview", tenantDatabase });
    expect(endpoints).toEqual([expect.objectContaining({ id: own.endpointId, destinationHost: "api.example.com", subscriptionCount: 1 })]);
    expect(JSON.stringify(endpoints)).not.toContain(sensitive);
    expect(await listWebhookEndpoints({ organizationId: "inspection-owner", environment: "staging", tenantDatabase })).toEqual([]);
    expect(await listWebhookEndpoints({ organizationId: "inspection-other", environment: "preview", tenantDatabase })).toEqual([expect.objectContaining({ id: other.endpointId })]);
    expect(await listWebhookSubscriptions({ organizationId: "inspection-owner", environment: "preview", endpointId: own.endpointId, tenantDatabase })).toEqual([{ type: "article.published", version: 1 }]);
    expect(await listWebhookSubscriptions({ organizationId: "inspection-other", environment: "preview", endpointId: own.endpointId, tenantDatabase })).toBeNull();
    expect(await listWebhookSubscriptions({ organizationId: "inspection-owner", environment: "staging", endpointId: own.endpointId, tenantDatabase })).toBeNull();

    const deliveries = await listWebhookDeliveries({ organizationId: "inspection-owner", environment: "preview", endpointId: own.endpointId, tenantDatabase });
    expect(deliveries).toEqual([expect.objectContaining({ id: own.deliveryId, messageId: own.messageId, eventType: "article.published", payloadAvailable: true })]);
    expect(JSON.stringify(deliveries)).not.toContain(sensitive);
    expect(await listWebhookDeliveries({ organizationId: "inspection-other", environment: "preview", endpointId: own.endpointId, tenantDatabase })).toEqual([]);
    expect(await listWebhookDeliveries({ organizationId: "inspection-owner", environment: "staging", endpointId: own.endpointId, tenantDatabase })).toEqual([]);

    const attempts = await listWebhookAttempts({ organizationId: "inspection-owner", environment: "preview", deliveryId: own.deliveryId, tenantDatabase });
    expect(attempts).toEqual([expect.objectContaining({ attemptNumber: 1, outcome: "retry", responseStatus: 503 })]);
    expect(JSON.stringify(attempts)).not.toContain(sensitive);
    expect(await listWebhookAttempts({ organizationId: "inspection-other", environment: "preview", deliveryId: own.deliveryId, tenantDatabase })).toEqual([]);
    expect(await listWebhookAttempts({ organizationId: "inspection-owner", environment: "staging", deliveryId: own.deliveryId, tenantDatabase })).toEqual([]);

    await sql!`update webhook_message set envelope=null, payload_deleted_at=now() where id=${own.messageId}`;
    expect(await listWebhookDeliveries({ organizationId: "inspection-owner", environment: "preview", endpointId: own.endpointId, tenantDatabase })).toEqual([expect.objectContaining({ payloadAvailable: false })]);
    await expect(listWebhookEndpoints({ organizationId: "inspection-owner", environment: "preview", tenantDatabase, limit: 101 })).rejects.toThrow("page size");
  });
});
