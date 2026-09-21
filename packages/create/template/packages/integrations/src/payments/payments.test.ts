import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { InMemoryBillingProjectionRepository, LocalBillingAdapter } from "./adapters/local.js";
import { verifyAndNormalizeStripeEvent } from "./events.js";

const plans = { starter: ["article.basic"], pro: ["article.basic", "workflows.advanced"] };

describe("payments boundary", () => {
  it("uses local canonical state without a Stripe account", async () => {
    const repository = new InMemoryBillingProjectionRepository();
    const billing = new LocalBillingAdapter(repository, plans);
    await billing.createCheckoutSession({ organizationId: "org-1", plan: "pro", requestId: "request-1" });
    expect(await billing.getSubscription("org-1")).toMatchObject({ provider: "local", status: "active", entitlements: ["article.basic", "workflows.advanced"] });
  });

  it("accepts a valid raw-body Stripe signature and rejects a modified body", () => {
    const payload = JSON.stringify({ id: "evt_1", object: "event", api_version: "2026-08-27.basil", created: 1_790_000_000, data: { object: { id: "sub_1", object: "subscription", customer: "cus_1", status: "active", metadata: { organizationId: "org-1", plan: "pro" } } }, livemode: false, pending_webhooks: 1, request: null, type: "customer.subscription.created" });
    const secret = "whsec_test";
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: Math.floor(Date.now() / 1000) });
    expect(verifyAndNormalizeStripeEvent(payload, signature, secret)).toMatchObject({ type: "SubscriptionActivated", organizationId: "org-1", plan: "pro", status: "active" });
    expect(() => verifyAndNormalizeStripeEvent(`${payload} `, signature, secret)).toThrow();
  });
});
