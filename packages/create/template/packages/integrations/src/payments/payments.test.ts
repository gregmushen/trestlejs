import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { InMemoryBillingProjectionRepository, LocalBillingAdapter } from "./adapters/local.js";
import { retrieveCurrentStripeSubscription, verifyAndNormalizeStripeEvent, type NormalizedBillingEvent } from "./events.js";

const plans = { starter: ["article.basic"], pro: ["article.basic", "workflows.advanced"] };

describe("payments boundary", () => {
  it("uses local canonical state without a Stripe account", async () => {
    const repository = new InMemoryBillingProjectionRepository();
    const billing = new LocalBillingAdapter(repository, plans);
    await billing.createCheckoutSession({ organizationId: "org-1", plan: "pro", requestId: "request-1" });
    expect(await billing.getSubscription("org-1")).toMatchObject({ provider: "local", status: "active", entitlements: ["article.basic", "workflows.advanced"] });
  });

  it("accepts a valid raw-body Stripe signature and rejects a modified body", () => {
    const payload = JSON.stringify({ id: "evt_1", object: "event", api_version: "2026-08-27.basil", created: 1_790_000_000, data: { object: { id: "sub_1", object: "subscription", customer: "cus_1", status: "active", cancel_at_period_end: true, items: { data: [{ current_period_start: 1_790_000_000, current_period_end: 1_792_592_000 }] }, metadata: { organizationId: "org-1", plan: "pro" } } }, livemode: false, pending_webhooks: 1, request: null, type: "customer.subscription.created" });
    const secret = "whsec_test";
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: Math.floor(Date.now() / 1000) });
    expect(verifyAndNormalizeStripeEvent(payload, signature, secret)).toMatchObject({ type: "SubscriptionActivated", organizationId: "org-1", plan: "pro", status: "active", cancelAtPeriodEnd: true, currentPeriodStart: new Date(1_790_000_000_000), currentPeriodEnd: new Date(1_792_592_000_000) });
    expect(() => verifyAndNormalizeStripeEvent(`${payload} `, signature, secret)).toThrow();
  });

  it("uses current subscription state instead of an older signed snapshot", async () => {
    const event: NormalizedBillingEvent = { id: "evt_old", type: "SubscriptionActivated", providerSubscriptionId: "sub_1",
      organizationId: "org-1", plan: "pro", status: "active", occurredAt: new Date("2026-09-24T00:00:00Z") };
    const current = { id: "sub_1", customer: "cus_1", status: "canceled", cancel_at_period_end: true,
      metadata: { organizationId: "org-1", plan: "starter" }, items: { data: [] } } as unknown as Stripe.Subscription;
    expect(await retrieveCurrentStripeSubscription({ secretKey: "sk_test_unit", event, lookup: async () => current })).toMatchObject({
      id: "evt_old", type: "SubscriptionCancelled", organizationId: "org-1", plan: "starter", status: "cancelled",
      providerSubscriptionId: "sub_1", cancelAtPeriodEnd: true,
    });
  });

  it("fails closed when the lookup changes identity or the provider is unavailable", async () => {
    const event: NormalizedBillingEvent = { id: "evt_old", type: "SubscriptionUpdated", providerSubscriptionId: "sub_1", occurredAt: new Date() };
    await expect(retrieveCurrentStripeSubscription({ secretKey: "sk_test_unit", event,
      lookup: async () => ({ id: "sub_2" }) as Stripe.Subscription })).rejects.toThrow("different provider identity");
    await expect(retrieveCurrentStripeSubscription({ secretKey: "sk_test_unit", event,
      lookup: async () => { throw new Error("private provider payload"); } })).rejects.toThrow("reconciliation is unavailable");
  });
});
