import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { applyBillingNotificationEvent, applyBillingProviderEvent, type BillingWebhookProjection } from "./billing-events.js";
import { outboxApplicationConnectionString } from "./outbox.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 4, prepare: false }) : undefined;
const applicationSql = databaseUrl ? postgres(outboxApplicationConnectionString(databaseUrl), { max: 1, prepare: false }) : undefined;
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
    if (eventIds.length) await sql!`delete from outbox_message where idempotency_key = any(${eventIds.map((id) => `billing:stripe:${id}`)})`;
    if (subscriptionIds.length) await sql!`delete from billing_subscription_reconciliation where provider='stripe' and provider_subscription_id = any(${subscriptionIds})`;
    if (subscriptionIds.length) await sql!`delete from billing_subscription_ownership where provider='stripe' and provider_subscription_id = any(${subscriptionIds})`;
    await applicationSql!.end();
    await sql!.end();
  });

  it("commits the receipt, subscription, and entitlements together and ignores a duplicate", async () => {
    const input = fixture();
    expect(await applyBillingProviderEvent(input)).toEqual({ duplicate: false });
    expect((await sql!`select status, error from billing_provider_event where provider='stripe' and provider_event_id=${input.providerEventId}`)[0]).toEqual({ status: "processed", error: null });
    expect((await sql!`select plan, status from organization_subscription where organization_id=${input.projection.organizationId}`)[0]).toEqual({ plan: "pro", status: "active" });
    expect((await sql!`select entitlement from organization_entitlement where organization_id=${input.projection.organizationId} order by entitlement`).map((row) => row.entitlement)).toEqual(["article.basic", "workflows.advanced"]);
    const [outbox] = await sql!`select event_name, resource_type, resource_id, organization_id, correlation_id, causation_id, idempotency_key, payload, status from outbox_message where idempotency_key=${`billing:stripe:${input.providerEventId}`}`;
    expect(outbox).toMatchObject({ event_name: "billing.subscription.activated", resource_type: "organization",
      resource_id: input.projection.organizationId, organization_id: input.projection.organizationId,
      correlation_id: input.providerEventId, causation_id: input.providerEventId,
      idempotency_key: `billing:stripe:${input.providerEventId}`, status: "pending",
      payload: { organizationId: input.projection.organizationId, plan: "pro", status: "active" } });
    expect(JSON.stringify(outbox?.payload)).not.toContain("cus_test");
    expect(JSON.stringify(outbox?.payload)).not.toContain(input.projection.providerSubscriptionId);
    expect(await applyBillingProviderEvent({ ...input, projection: { ...input.projection, plan: "starter", entitlements: [] } })).toEqual({ duplicate: true });
    expect((await sql!`select plan from organization_subscription where organization_id=${input.projection.organizationId}`)[0]?.plan).toBe("pro");
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${input.providerEventId}`}`).toHaveLength(1);
  });

  it("retries an early invoice and publishes exactly once after ownership is established", async () => {
    const subscription = fixture();
    const providerEventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    eventIds.push(providerEventId);
    const notification = { databaseUrl: databaseUrl!, driver: "postgres-js" as const, provider: "stripe",
      providerEventId, providerSubscriptionId: subscription.projection.providerSubscriptionId!,
      providerCustomerId: "cus_test", organizationId: subscription.projection.organizationId,
      type: "InvoicePaid" as const, amountMinor: 2500, currency: "usd", correlationId: "invoice-request",
      occurredAt: new Date() };
    expect(await applyBillingNotificationEvent(notification)).toEqual({ duplicate: false, unresolved: true });
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${providerEventId}`}`).toHaveLength(0);
    expect(await applyBillingProviderEvent(subscription)).toEqual({ duplicate: false });
    expect((await Promise.all([applyBillingNotificationEvent(notification), applyBillingNotificationEvent(notification)]))
      .map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect((await sql!`select event_name, payload, correlation_id from outbox_message where idempotency_key=${`billing:stripe:${providerEventId}`}`)[0])
      .toMatchObject({ event_name: "billing.invoice.paid", payload: { organizationId: notification.organizationId,
        currentSubscription: true, amountMinor: 2500, currency: "usd" }, correlation_id: "invoice-request" });
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${providerEventId}`}`).toHaveLength(1);
  });

  it("rejects cross-tenant and changed subscription identities without publishing", async () => {
    const subscription = fixture();
    const other = fixture();
    expect(await applyBillingProviderEvent(subscription)).toEqual({ duplicate: false });
    const providerEventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    eventIds.push(providerEventId);
    const notification = { databaseUrl: databaseUrl!, driver: "postgres-js" as const, provider: "stripe",
      providerEventId, providerSubscriptionId: subscription.projection.providerSubscriptionId!,
      organizationId: other.projection.organizationId, type: "BillingCheckoutCompleted" as const,
      paymentStatus: "paid" as const, correlationId: providerEventId, occurredAt: new Date() };
    expect(await applyBillingNotificationEvent(notification)).toEqual({ duplicate: false, unresolved: true });
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${providerEventId}`}`).toHaveLength(0);
    await expect(applyBillingNotificationEvent({ ...notification, organizationId: subscription.projection.organizationId,
      providerSubscriptionId: other.projection.providerSubscriptionId! })).rejects.toThrow("identity changed");
    expect(await applyBillingNotificationEvent({ ...notification, organizationId: subscription.projection.organizationId }))
      .toEqual({ duplicate: false });
  });

  it("rolls back invalid invoice payloads and leaves their receipt retryable", async () => {
    const subscription = fixture();
    expect(await applyBillingProviderEvent(subscription)).toEqual({ duplicate: false });
    const providerEventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    eventIds.push(providerEventId);
    const notification = { databaseUrl: databaseUrl!, driver: "postgres-js" as const, provider: "stripe",
      providerEventId, providerSubscriptionId: subscription.projection.providerSubscriptionId!,
      organizationId: subscription.projection.organizationId, type: "InvoicePaymentFailed" as const,
      amountMinor: 3000, currency: "invalid", correlationId: providerEventId, occurredAt: new Date() };
    await expect(applyBillingNotificationEvent(notification)).rejects.toThrow();
    expect((await sql!`select status from billing_provider_event where provider_event_id=${providerEventId}`)[0]?.status).toBe("failed");
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${providerEventId}`}`).toHaveLength(0);
    expect(await applyBillingNotificationEvent({ ...notification, currency: "usd" })).toEqual({ duplicate: false });
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${providerEventId}`}`).toHaveLength(1);
  });

  it("rolls back an invalid entitlement projection, records failure, then safely retries", async () => {
    const input = fixture({ entitlements: ["duplicate", "duplicate"] });
    await expect(applyBillingProviderEvent(input)).rejects.toThrow();
    expect((await sql!`select status, error from billing_provider_event where provider='stripe' and provider_event_id=${input.providerEventId}`)[0]).toEqual({ status: "failed", error: "projection_failed" });
    expect(await sql!`select organization_id from organization_subscription where organization_id=${input.projection.organizationId}`).toHaveLength(0);
    expect(await sql!`select organization_id from organization_entitlement where organization_id=${input.projection.organizationId}`).toHaveLength(0);
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${input.providerEventId}`}`).toHaveLength(0);
    expect(await applyBillingProviderEvent({ ...input, projection: { ...input.projection, entitlements: ["duplicate"] } })).toEqual({ duplicate: false });
    expect((await sql!`select status, error from billing_provider_event where provider='stripe' and provider_event_id=${input.providerEventId}`)[0]).toEqual({ status: "processed", error: null });
    expect((await sql!`select entitlement from organization_entitlement where organization_id=${input.projection.organizationId}`).map((row) => row.entitlement)).toEqual(["duplicate"]);
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${input.providerEventId}`}`).toHaveLength(1);
  });

  it("serializes concurrent duplicate deliveries so the projection runs once", async () => {
    const input = fixture();
    const results = await Promise.all([applyBillingProviderEvent(input), applyBillingProviderEvent(input)]);
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect(await sql!`select provider_event_id from billing_provider_event where provider='stripe' and provider_event_id=${input.providerEventId}`).toHaveLength(1);
    expect(await sql!`select entitlement from organization_entitlement where organization_id=${input.projection.organizationId}`).toHaveLength(2);
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${input.providerEventId}`}`).toHaveLength(1);
  }, 15_000);

  it("rolls back the projection and receipt finalization when a domain event is invalid", async () => {
    const input = fixture({ entitlements: [""] });
    await expect(applyBillingProviderEvent(input)).rejects.toThrow("Internal event payload fails its schema");
    expect((await sql!`select status from billing_provider_event where provider_event_id=${input.providerEventId}`)[0]?.status).toBe("failed");
    expect(await sql!`select organization_id from organization_subscription where organization_id=${input.projection.organizationId}`).toHaveLength(0);
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${input.providerEventId}`}`).toHaveLength(0);
    expect(await applyBillingProviderEvent({ ...input, projection: { ...input.projection, entitlements: ["article.basic"] } }))
      .toEqual({ duplicate: false });
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${input.providerEventId}`}`).toHaveLength(1);
  });

  it("publishes normalized plan, past-due, and cancellation transitions with request correlation", async () => {
    const activated = fixture();
    expect(await applyBillingProviderEvent({ ...activated, correlationId: "request-billing-1" })).toEqual({ duplicate: false });
    const updatedId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const pastDueId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const cancelledId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    eventIds.push(updatedId, pastDueId, cancelledId);
    expect(await applyBillingProviderEvent({ ...activated, providerEventId: updatedId, type: "SubscriptionUpdated",
      projection: { ...activated.projection, plan: "starter", entitlements: ["article.basic"] } })).toEqual({ duplicate: false });
    expect(await applyBillingProviderEvent({ ...activated, providerEventId: pastDueId, type: "SubscriptionPastDue",
      projection: { ...activated.projection, plan: "starter", status: "past_due", entitlements: [] } })).toEqual({ duplicate: false });
    expect(await applyBillingProviderEvent({ ...activated, providerEventId: cancelledId, type: "SubscriptionCancelled",
      projection: { ...activated.projection, plan: "starter", status: "cancelled", entitlements: [] } })).toEqual({ duplicate: false });
    expect((await sql!`select event_name, correlation_id, payload from outbox_message where idempotency_key=${`billing:stripe:${activated.providerEventId}`}`)[0])
      .toMatchObject({ event_name: "billing.subscription.activated", correlation_id: "request-billing-1" });
    expect((await sql!`select event_name, payload from outbox_message where idempotency_key=${`billing:stripe:${updatedId}`}`)[0])
      .toMatchObject({ event_name: "billing.subscription.updated", payload: { previousPlan: "pro", previousStatus: "active", plan: "starter" } });
    expect((await sql!`select event_name, payload from outbox_message where idempotency_key=${`billing:stripe:${pastDueId}`}`)[0])
      .toMatchObject({ event_name: "billing.subscription.past_due", payload: { previousStatus: "active", status: "past_due" } });
    expect((await sql!`select event_name, payload from outbox_message where idempotency_key=${`billing:stripe:${cancelledId}`}`)[0])
      .toMatchObject({ event_name: "billing.subscription.cancelled", payload: { previousStatus: "past_due", status: "cancelled" } });
    expect(await sql!`select entitlement from organization_entitlement where organization_id=${activated.projection.organizationId}`).toHaveLength(0);
  });

  it("never transfers one provider subscription to a second organization", async () => {
    const owner = fixture();
    const attacker = fixture({ providerSubscriptionId: owner.projection.providerSubscriptionId });
    expect(await applyBillingProviderEvent(owner)).toEqual({ duplicate: false });
    await expect(applyBillingProviderEvent(attacker)).rejects.toThrow("ownership conflict");
    expect(await sql!`select organization_id from organization_subscription where organization_id=${attacker.projection.organizationId}`).toHaveLength(0);
    expect(await sql!`select entitlement from organization_entitlement where organization_id=${attacker.projection.organizationId}`).toHaveLength(0);
    expect((await sql!`select organization_id from billing_subscription_ownership where provider='stripe' and provider_subscription_id=${owner.projection.providerSubscriptionId}`)[0]?.organization_id)
      .toBe(owner.projection.organizationId);
    expect(await applicationSql!`select organization_id from billing_subscription_ownership where provider='stripe' and provider_subscription_id=${owner.projection.providerSubscriptionId}`)
      .toHaveLength(0);
    expect((await sql!`select status, error from billing_provider_event where provider_event_id=${attacker.providerEventId}`)[0])
      .toEqual({ status: "failed", error: "projection_failed" });
  });

  it("does not grant the application role permission to rewrite ownership", async () => {
    const input = fixture();
    expect(await applyBillingProviderEvent(input)).toEqual({ duplicate: false });
    await expect(applicationSql!`update billing_subscription_ownership set organization_id='other' where provider='stripe' and provider_subscription_id=${input.projection.providerSubscriptionId}`)
      .rejects.toThrow(/permission denied/u);
    await expect(applicationSql!`delete from billing_subscription_ownership where provider='stripe' and provider_subscription_id=${input.projection.providerSubscriptionId}`)
      .rejects.toThrow(/permission denied/u);
    expect((await sql!`select organization_id from billing_subscription_ownership where provider='stripe' and provider_subscription_id=${input.projection.providerSubscriptionId}`)[0]?.organization_id)
      .toBe(input.projection.organizationId);
  });

  it("rejects a competing subscription while the current one is active", async () => {
    const original = fixture();
    const competingEventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const competingSubscriptionId = `sub_${crypto.randomUUID().replaceAll("-", "")}`;
    eventIds.push(competingEventId);
    subscriptionIds.push(competingSubscriptionId);
    expect(await applyBillingProviderEvent(original)).toEqual({ duplicate: false });
    await expect(applyBillingProviderEvent({ ...original, providerEventId: competingEventId,
      projection: { ...original.projection, providerSubscriptionId: competingSubscriptionId } }))
      .rejects.toThrow("cannot be replaced");
    expect((await sql!`select provider_subscription_id from organization_subscription where organization_id=${original.projection.organizationId}`)[0]?.provider_subscription_id)
      .toBe(original.projection.providerSubscriptionId);
    expect(await sql!`select provider_subscription_id from billing_subscription_ownership where provider='stripe' and provider_subscription_id=${competingSubscriptionId}`)
      .toHaveLength(0);
  });

  it("allows a canceled subscription to be replaced but supersedes later old events", async () => {
    const old = fixture({ status: "cancelled", entitlements: [] });
    const replacementEventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const staleEventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const replacementSubscriptionId = `sub_${crypto.randomUUID().replaceAll("-", "")}`;
    eventIds.push(replacementEventId, staleEventId);
    subscriptionIds.push(replacementSubscriptionId);
    expect(await applyBillingProviderEvent(old)).toEqual({ duplicate: false });
    expect(await applyBillingProviderEvent({ ...old, providerEventId: replacementEventId,
      projection: { ...old.projection, providerSubscriptionId: replacementSubscriptionId, status: "active",
        entitlements: ["workflows.advanced"] } })).toEqual({ duplicate: false });
    expect(await applyBillingProviderEvent({ ...old, providerEventId: staleEventId,
      projection: { ...old.projection, status: "active", entitlements: ["article.basic"] } }))
      .toEqual({ duplicate: false, superseded: true });
    expect((await sql!`select provider_subscription_id from organization_subscription where organization_id=${old.projection.organizationId}`)[0]?.provider_subscription_id)
      .toBe(replacementSubscriptionId);
    expect((await sql!`select entitlement from organization_entitlement where organization_id=${old.projection.organizationId}`)
      .map((row) => row.entitlement)).toEqual(["workflows.advanced"]);
  });

  it("serializes two organizations racing to claim the same provider identity", async () => {
    const first = fixture();
    const second = fixture({ providerSubscriptionId: first.projection.providerSubscriptionId });
    const results = await Promise.allSettled([applyBillingProviderEvent(first), applyBillingProviderEvent(second)]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const [binding] = await sql!`select organization_id from billing_subscription_ownership where provider='stripe' and provider_subscription_id=${first.projection.providerSubscriptionId}`;
    const projections = await sql!`select organization_id from organization_subscription where organization_id in (${first.projection.organizationId}, ${second.projection.organizationId})`;
    expect(projections).toHaveLength(1);
    expect(projections[0]?.organization_id).toBe(binding?.organization_id);
  });
});
