import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { applyBillingProviderEvent, beginBillingSubscriptionReconciliation, type BillingWebhookProjection } from "./billing-events.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 4, prepare: false }) : undefined;
const eventIds: string[] = [];
const organizationIds: string[] = [];
const subscriptionIds: string[] = [];

function fixture(overrides: Partial<BillingWebhookProjection> = {}) {
  const organizationId = `billing_atomic_${crypto.randomUUID().replaceAll("-", "")}`;
  const providerEventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
  organizationIds.push(organizationId);
  eventIds.push(providerEventId);
  const providerSubscriptionId = `sub_${organizationId}`;
  subscriptionIds.push(providerSubscriptionId);
  return {
    databaseUrl: databaseUrl!, driver: "postgres-js" as const, provider: "stripe", providerEventId,
    type: "SubscriptionActivated",
    projection: { organizationId, providerCustomerId: "cus_test", providerSubscriptionId, plan: "pro", planVersion: 1,
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
    if (subscriptionIds.length) await sql!`delete from billing_subscription_reconciliation where provider='stripe' and provider_subscription_id = any(${subscriptionIds})`;
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

  it("supersedes a slow stale lookup while a newer subscription reconciliation commits", async () => {
    const older = fixture();
    const newerId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    eventIds.push(newerId);
    const newer = { ...older, providerEventId: newerId, type: "SubscriptionCancelled", projection: { ...older.projection, status: "cancelled" as const, entitlements: [] } };
    const first = await beginBillingSubscriptionReconciliation({ ...older, providerSubscriptionId: older.projection.providerSubscriptionId! });
    const second = await beginBillingSubscriptionReconciliation({ ...newer, providerSubscriptionId: newer.projection.providerSubscriptionId! });
    expect(first).toMatchObject({ duplicate: false, generation: 1 });
    expect(second).toMatchObject({ duplicate: false, generation: 2 });
    if (first.duplicate || second.duplicate) throw new Error("Unexpected duplicate reconciliation");
    expect(await applyBillingProviderEvent({ ...older, reconciliation: { providerSubscriptionId: older.projection.providerSubscriptionId!, generation: first.generation } }))
      .toEqual({ duplicate: false, superseded: true });
    expect(await sql!`select organization_id from organization_subscription where organization_id=${older.projection.organizationId}`).toHaveLength(0);
    expect(await applyBillingProviderEvent({ ...newer, reconciliation: { providerSubscriptionId: newer.projection.providerSubscriptionId!, generation: second.generation } }))
      .toEqual({ duplicate: false });
    expect((await sql!`select status from organization_subscription where organization_id=${older.projection.organizationId}`)[0]?.status).toBe("cancelled");
    expect(await sql!`select entitlement from organization_entitlement where organization_id=${older.projection.organizationId}`).toHaveLength(0);
    expect((await sql!`select status from billing_provider_event where provider_event_id=${older.providerEventId}`)[0]?.status).toBe("superseded");
    expect(await beginBillingSubscriptionReconciliation({ ...older, providerSubscriptionId: older.projection.providerSubscriptionId! })).toEqual({ duplicate: true });
  });

  it("retries a failed reconciliation with a fresh generation", async () => {
    const input = fixture({ entitlements: ["duplicate", "duplicate"] });
    const identity = { ...input, providerSubscriptionId: input.projection.providerSubscriptionId! };
    const first = await beginBillingSubscriptionReconciliation(identity);
    if (first.duplicate) throw new Error("Unexpected duplicate reconciliation");
    await expect(applyBillingProviderEvent({ ...input, reconciliation: { providerSubscriptionId: identity.providerSubscriptionId, generation: first.generation } })).rejects.toThrow();
    expect((await sql!`select status from billing_provider_event where provider_event_id=${input.providerEventId}`)[0]?.status).toBe("failed");
    const second = await beginBillingSubscriptionReconciliation(identity);
    if (second.duplicate) throw new Error("Unexpected duplicate reconciliation");
    expect(second.generation).toBe(first.generation + 1);
    expect(await applyBillingProviderEvent({ ...input, projection: { ...input.projection, entitlements: ["duplicate"] },
      reconciliation: { providerSubscriptionId: identity.providerSubscriptionId, generation: second.generation } })).toEqual({ duplicate: false });
  });

  it("assigns distinct generations to concurrent events for one subscription", async () => {
    const input = fixture();
    const nextEventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    eventIds.push(nextEventId);
    const identity = { ...input, providerSubscriptionId: input.projection.providerSubscriptionId! };
    const [first, second] = await Promise.all([
      beginBillingSubscriptionReconciliation(identity),
      beginBillingSubscriptionReconciliation({ ...identity, providerEventId: nextEventId }),
    ]);
    if (first.duplicate || second.duplicate) throw new Error("Unexpected duplicate reconciliation");
    expect([first.generation, second.generation].sort()).toEqual([1, 2]);
  });
});
