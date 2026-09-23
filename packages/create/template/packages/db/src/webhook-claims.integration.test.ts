import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { createTenantDatabase } from "./index.js";
import { claimNativeWebhookDelivery } from "./webhook-claims.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 2, prepare: false }) : undefined;
const endpointIds: string[] = [];
const messageIds: string[] = [];
const deliveryIds: string[] = [];
const tenantDatabase = (organizationId: string) => createTenantDatabase(databaseUrl!, "postgres-js", organizationId);
const initialTime = new Date("2026-09-22T12:00:00.000Z");

async function fixture(organizationId: string, options: { provider?: "native" | "local"; state?: "active" | "paused"; dueAt?: Date } = {}) {
  const [endpoint] = await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by) values (${organizationId}, 'preview', ${crypto.randomUUID()}, 'https://example.com/hook', ${options.state ?? "active"}, ${options.provider ?? "native"}, 'test-user', 'test-user') returning id`;
  if (!endpoint) throw new Error("Endpoint fixture failed");
  const messageId = `whm_claim_${crypto.randomUUID()}`;
  const deliveryId = `whd_claim_${crypto.randomUUID()}`;
  endpointIds.push(endpoint.id);
  messageIds.push(messageId);
  deliveryIds.push(deliveryId);
  await sql!`insert into webhook_message (id, organization_id, source_event_id, public_event_type, public_version, occurred_at, resource_type, resource_id, envelope, payload_size, retention_class, entitlement_decision, status, correlation_id) values (${messageId}, ${organizationId}, ${crypto.randomUUID()}, 'article.published', 1, ${initialTime}, 'article', 'article-1', ${sql!.json({ id: messageId })}, 2, 'standard', 'not_required', 'ready', ${crypto.randomUUID()})`;
  await sql!`insert into webhook_delivery (id, organization_id, message_id, endpoint_id, next_attempt_at) values (${deliveryId}, ${organizationId}, ${messageId}, ${endpoint.id}, ${options.dueAt ?? initialTime})`;
  return { endpointId: endpoint.id, deliveryId };
}

suite("native webhook delivery leases", () => {
  afterAll(async () => {
    if (deliveryIds.length) await sql!`delete from webhook_delivery where id = any(${deliveryIds})`;
    if (messageIds.length) await sql!`delete from webhook_message where id = any(${messageIds})`;
    if (endpointIds.length) await sql!`delete from webhook_endpoint where id = any(${endpointIds})`;
    await sql!.end();
  });

  it("lets only one duplicate wake-up claim a due delivery", async () => {
    const { deliveryId } = await fixture("claim-duplicate");
    const input = { organizationId: "claim-duplicate", deliveryId, tenantDatabase, clock: { now: () => initialTime } };
    const results = await Promise.all([claimNativeWebhookDelivery(input), claimNativeWebhookDelivery(input)]);
    expect(results.map((result) => result.state).sort()).toEqual(["leased", "not_due"]);
    const leased = results.find((result) => result.state === "leased");
    expect(leased).toMatchObject({ attemptNumber: 1, leasedUntil: new Date(initialTime.getTime() + 30_000) });
    const [row] = await sql!`select state, lease_token, leased_until, attempt_count from webhook_delivery where id=${deliveryId}`;
    expect(row).toMatchObject({ state: "leased", lease_token: leased?.state === "leased" ? leased.leaseToken : undefined, attempt_count: 0 });
  });

  it("reclaims an expired lease with a new token, never a live one", async () => {
    const { deliveryId } = await fixture("claim-expired");
    const at = (milliseconds: number) => ({ now: () => new Date(initialTime.getTime() + milliseconds) });
    const base = { organizationId: "claim-expired", deliveryId, tenantDatabase, leaseMs: 1_000 };
    const first = await claimNativeWebhookDelivery({ ...base, clock: at(0) });
    expect(first.state).toBe("leased");
    expect(await claimNativeWebhookDelivery({ ...base, clock: at(999) })).toEqual({ state: "not_due" });
    const recovered = await claimNativeWebhookDelivery({ ...base, clock: at(1_000) });
    expect(recovered.state).toBe("leased");
    if (first.state !== "leased" || recovered.state !== "leased") throw new Error("Expected both claims");
    expect(recovered.leaseToken).not.toBe(first.leaseToken);
    expect(recovered.attemptNumber).toBe(1);
  });

  it("fails closed for another tenant, inactive or local endpoints, and future work", async () => {
    const native = await fixture("claim-owner");
    const paused = await fixture("claim-paused", { state: "paused" });
    const local = await fixture("claim-local", { provider: "local" });
    const future = await fixture("claim-future", { dueAt: new Date(initialTime.getTime() + 60_000) });
    const claim = (organizationId: string, deliveryId: string) => claimNativeWebhookDelivery({ organizationId, deliveryId, tenantDatabase, clock: { now: () => initialTime } });
    expect(await claim("other-tenant", native.deliveryId)).toEqual({ state: "not_found" });
    expect(await claim("claim-paused", paused.deliveryId)).toEqual({ state: "inactive" });
    expect(await claim("claim-local", local.deliveryId)).toEqual({ state: "not_native" });
    expect(await claim("claim-future", future.deliveryId)).toEqual({ state: "not_due" });
    expect((await sql!`select state from webhook_delivery where id in (${native.deliveryId},${paused.deliveryId},${local.deliveryId},${future.deliveryId})`).every((row) => row.state === "pending")).toBe(true);
  });

  it("enforces the database lease invariant and rejects invalid clock or duration", async () => {
    const { deliveryId } = await fixture("claim-invalid");
    const base = { organizationId: "claim-invalid", deliveryId, tenantDatabase };
    await expect(claimNativeWebhookDelivery({ ...base, clock: { now: () => initialTime }, leaseMs: 999 })).rejects.toThrow("lease duration");
    await expect(claimNativeWebhookDelivery({ ...base, clock: { now: () => new Date("invalid") } })).rejects.toThrow("clock");
    await expect(sql!`update webhook_delivery set state='leased' where id=${deliveryId}`).rejects.toThrow();
    expect((await sql!`select relforcerowsecurity from pg_class where relname='webhook_delivery'`)[0]?.relforcerowsecurity).toBe(true);
  });
});
