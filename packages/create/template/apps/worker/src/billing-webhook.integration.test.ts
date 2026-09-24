import { createHmac } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { app } from "./index.js";

const databaseUrl = process.env.TRESTLE_SYSTEM_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 2, prepare: false }) : undefined;
const organizationIds: string[] = [];
const eventIds: string[] = [];
const secret = "whsec_billing_webhook_integration";

async function deliver(input: { eventId: string; organizationId?: string; plan?: string; kind?: "subscription" | "checkout" }) {
  const metadata = { ...(input.organizationId ? { organizationId: input.organizationId } : {}), ...(input.plan ? { plan: input.plan } : {}) };
  const checkout = input.kind === "checkout";
  const payload = JSON.stringify({ id: input.eventId, object: "event", api_version: "2026-08-27.basil", created: Math.floor(Date.now() / 1000), data: {
    object: checkout ? { id: "cs_test_atomic", object: "checkout.session", customer: "cus_test_atomic", subscription: "sub_test_atomic", metadata }
      : { id: "sub_test_atomic", object: "subscription", customer: "cus_test_atomic", status: "active", cancel_at_period_end: true, items: { data: [{ current_period_start: 1_790_000_000, current_period_end: 1_792_592_000 }] }, metadata },
  }, livemode: false, pending_webhooks: 1, request: null, type: checkout ? "checkout.session.completed" : "customer.subscription.created" });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")}`;
  return app.request("/webhooks/stripe", { method: "POST", headers: { "stripe-signature": signature, "content-type": "application/json" }, body: payload }, {
    DATABASE_URL: databaseUrl!, DATABASE_DRIVER: "postgres-js", STRIPE_WEBHOOK_SECRET: secret,
    BETTER_AUTH_SECRET: "billing-integration-test-secret-long-enough", BETTER_AUTH_URL: "http://localhost:42069", APP_ENV: "local",
  });
}

suite("signed Stripe webhook route", () => {
  afterAll(async () => {
    if (organizationIds.length) {
      await sql!`delete from organization_entitlement where organization_id = any(${organizationIds})`;
      await sql!`delete from organization_subscription where organization_id = any(${organizationIds})`;
    }
    if (eventIds.length) await sql!`delete from billing_provider_event where provider='stripe' and provider_event_id = any(${eventIds})`;
    await sql!.end();
  });

  it("activates entitlements from a signed subscription once and acknowledges duplicates", async () => {
    const organizationId = `billing_route_${crypto.randomUUID().replaceAll("-", "")}`;
    const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    organizationIds.push(organizationId);
    eventIds.push(eventId);
    const first = await deliver({ eventId, organizationId, plan: "pro" });
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({ duplicate: false, event: { type: "SubscriptionActivated", organizationId, status: "active" } });
    const duplicate = await deliver({ eventId, organizationId, plan: "pro" });
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({ duplicate: true });
    expect((await sql!`select plan, status, cancel_at_period_end, current_period_start, current_period_end from organization_subscription where organization_id=${organizationId}`)[0]).toEqual({ plan: "pro", status: "active", cancel_at_period_end: true, current_period_start: new Date(1_790_000_000_000), current_period_end: new Date(1_792_592_000_000) });
    expect((await sql!`select entitlement from organization_entitlement where organization_id=${organizationId} order by entitlement`).map((row) => row.entitlement)).toEqual(["article.basic", "members.unlimited", "workflows.advanced", "workspace.single"]);
  });

  it("rejects a signed subscription lacking tenant or plan metadata without an event receipt", async () => {
    const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    eventIds.push(eventId);
    const response = await deliver({ eventId });
    expect(response.status).toBe(422);
    expect(await sql!`select provider_event_id from billing_provider_event where provider='stripe' and provider_event_id=${eventId}`).toHaveLength(0);
  });

  it("records Checkout completion without granting paid entitlements before a subscription event", async () => {
    const organizationId = `billing_checkout_${crypto.randomUUID().replaceAll("-", "")}`;
    const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    organizationIds.push(organizationId);
    eventIds.push(eventId);
    const response = await deliver({ eventId, organizationId, plan: "pro", kind: "checkout" });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ duplicate: false, event: { type: "BillingCheckoutCompleted" } });
    expect(await sql!`select organization_id from organization_subscription where organization_id=${organizationId}`).toHaveLength(0);
    expect(await sql!`select organization_id from organization_entitlement where organization_id=${organizationId}`).toHaveLength(0);
    expect((await sql!`select status from billing_provider_event where provider='stripe' and provider_event_id=${eventId}`)[0]?.status).toBe("processed");
  });
});
