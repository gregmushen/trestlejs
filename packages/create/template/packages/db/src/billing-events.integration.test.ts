import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { applyBillingProviderEvent, type BillingWebhookProjection } from "./billing-events.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 4, prepare: false }) : undefined;
const eventIds: string[] = [];
const organizationIds: string[] = [];

function fixture(overrides: Partial<BillingWebhookProjection> = {}) {
  const organizationId = `billing_atomic_${crypto.randomUUID().replaceAll("-", "")}`;
  const providerEventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
  organizationIds.push(organizationId);
  eventIds.push(providerEventId);
  return {
    databaseUrl: databaseUrl!, driver: "postgres-js" as const, provider: "stripe", providerEventId,
    type: "SubscriptionActivated",
    projection: { organizationId, providerCustomerId: "cus_test", providerSubscriptionId: "sub_test", plan: "pro", planVersion: 1,
      status: "active" as const, entitlements: ["article.basic", "workflows.advanced"], ...overrides },
  };
}

suite("billing provider event atomicity", () => {
  afterAll(async () => {
    if (organizationIds.length) {
      await sql!`delete from organization_entitlement where organization_id = any(${organizationIds})`;
      await sql!`delete from organization_subscription where organization_id = any(${organizationIds})`;
    }
    if (eventIds.length) await sql!`delete from billing_provider_event where provider='stripe' and provider_event_id = any(${eventIds})`;
    await sql!.end();
  });

  it("commits the receipt, subscription, and entitlements together and ignores a duplicate", async () => {
    const input = fixture();
    expect(await applyBillingProviderEvent(input)).toEqual({ duplicate: false });
    expect((await sql!`select status, error from billing_provider_event where provider='stripe' and provider_event_id=${input.providerEventId}`)[0]).toEqual({ status: "processed", error: null });
    expect((await sql!`select plan, status from organization_subscription where organization_id=${input.projection.organizationId}`)[0]).toEqual({ plan: "pro", status: "active" });
    expect((await sql!`select entitlement from organization_entitlement where organization_id=${input.projection.organizationId} order by entitlement`).map((row) => row.entitlement)).toEqual(["article.basic", "workflows.advanced"]);
    expect(await applyBillingProviderEvent({ ...input, projection: { ...input.projection, plan: "starter", entitlements: [] } })).toEqual({ duplicate: true });
    expect((await sql!`select plan from organization_subscription where organization_id=${input.projection.organizationId}`)[0]?.plan).toBe("pro");
  });

  it("rolls back an invalid entitlement projection, records failure, then safely retries", async () => {
    const input = fixture({ entitlements: ["duplicate", "duplicate"] });
    await expect(applyBillingProviderEvent(input)).rejects.toThrow();
    expect((await sql!`select status, error from billing_provider_event where provider='stripe' and provider_event_id=${input.providerEventId}`)[0]).toEqual({ status: "failed", error: "projection_failed" });
    expect(await sql!`select organization_id from organization_subscription where organization_id=${input.projection.organizationId}`).toHaveLength(0);
    expect(await sql!`select organization_id from organization_entitlement where organization_id=${input.projection.organizationId}`).toHaveLength(0);
    expect(await applyBillingProviderEvent({ ...input, projection: { ...input.projection, entitlements: ["duplicate"] } })).toEqual({ duplicate: false });
    expect((await sql!`select status, error from billing_provider_event where provider='stripe' and provider_event_id=${input.providerEventId}`)[0]).toEqual({ status: "processed", error: null });
    expect((await sql!`select entitlement from organization_entitlement where organization_id=${input.projection.organizationId}`).map((row) => row.entitlement)).toEqual(["duplicate"]);
  });

  it("serializes concurrent duplicate deliveries so the projection runs once", async () => {
    const input = fixture();
    const results = await Promise.all([applyBillingProviderEvent(input), applyBillingProviderEvent(input)]);
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect(await sql!`select provider_event_id from billing_provider_event where provider='stripe' and provider_event_id=${input.providerEventId}`).toHaveLength(1);
    expect(await sql!`select entitlement from organization_entitlement where organization_id=${input.projection.organizationId}`).toHaveLength(2);
  });
});
