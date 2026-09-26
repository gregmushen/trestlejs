import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { InMemoryBillingProjectionRepository, InMemoryLocalBillingProvider, LocalBillingAdapter, retrieveCurrentLocalSubscription, type LocalBillingNotification } from "./adapters/local.js";
import { BillingSubscriptionNotFound } from "./types.js";
import { retrieveCurrentStripeSubscription, verifyAndNormalizeStripeEvent, type NormalizedBillingEvent } from "./events.js";

const plans = { starter: ["article.basic"], pro: ["article.basic", "workflows.advanced"] };

describe("payments boundary", () => {
  it("changes local provider state and notifies instead of writing the projection", async () => {
    const provider = new InMemoryLocalBillingProvider();
    const repository = new InMemoryBillingProjectionRepository();
    const notifications: LocalBillingNotification[] = [];
    const billing = new LocalBillingAdapter({ provider, repository, plans, notify: async (notification) => { notifications.push(notification); } });
    await billing.createCheckoutSession({ organizationId: "org-1", plan: "pro", requestId: "request-1" });
    expect(await billing.getSubscription("org-1")).toBeNull();
    expect(notifications).toEqual([expect.objectContaining({ provider: "local", providerSubscriptionId: "sub_local_org-1", type: "SubscriptionActivated" })]);
    expect(notifications[0]?.providerEventId).toMatch(/^evt_local_[0-9a-f]{32}$/u);
    await expect(retrieveCurrentLocalSubscription(provider, { id: "evt_1", type: "SubscriptionUpdated", providerSubscriptionId: "sub_local_org-1", occurredAt: new Date() }))
      .resolves.toMatchObject({ type: "SubscriptionUpdated", organizationId: "org-1", plan: "pro", status: "active", providerSubscriptionId: "sub_local_org-1" });
    await billing.failPayment({ organizationId: "org-1" });
    await billing.cancel({ organizationId: "org-1" });
    expect(notifications.map((notification) => notification.type)).toEqual(["SubscriptionActivated", "SubscriptionPastDue", "SubscriptionCancelled"]);
    await expect(billing.cancel({ organizationId: "org-1" })).rejects.toThrow("already cancelled");
    await expect(billing.failPayment({ organizationId: "org-2" })).rejects.toBeInstanceOf(BillingSubscriptionNotFound);
    await expect(billing.activate({ organizationId: "org-1", plan: "unknown" })).rejects.toThrow("unknown plan");
    await expect(retrieveCurrentLocalSubscription(provider, { id: "evt_2", type: "SubscriptionUpdated", providerSubscriptionId: "sub_local_missing", occurredAt: new Date() }))
      .rejects.toBeInstanceOf(BillingSubscriptionNotFound);
  });

  it("accepts a valid raw-body Stripe signature and rejects a modified body", async () => {
    const payload = JSON.stringify({ id: "evt_1", object: "event", api_version: "2026-08-27.basil", created: 1_790_000_000, data: { object: { id: "sub_1", object: "subscription", customer: "cus_1", status: "active", cancel_at_period_end: true, items: { data: [{ current_period_start: 1_790_000_000, current_period_end: 1_792_592_000 }] }, metadata: { organizationId: "org-1", plan: "pro" } } }, livemode: false, pending_webhooks: 1, request: null, type: "customer.subscription.created" });
    const secret = "whsec_test";
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: Math.floor(Date.now() / 1000) });
    await expect(verifyAndNormalizeStripeEvent(payload, signature, secret)).resolves.toMatchObject({ type: "SubscriptionActivated", organizationId: "org-1", plan: "pro", status: "active", cancelAtPeriodEnd: true, currentPeriodStart: new Date(1_790_000_000_000), currentPeriodEnd: new Date(1_792_592_000_000) });
    await expect(verifyAndNormalizeStripeEvent(`${payload} `, signature, secret)).rejects.toThrow();
  });

  it("normalizes Checkout and invoice notifications from subscription identity, not invoice metadata", async () => {
    const secret = "whsec_notifications";
    const normalize = (type: string, object: unknown) => {
      const payload = JSON.stringify({ id: `evt_${type.replaceAll(".", "_")}`, object: "event", created: 1_790_000_000,
        data: { object }, livemode: false, pending_webhooks: 1, request: null, type });
      const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: Math.floor(Date.now() / 1000) });
      return verifyAndNormalizeStripeEvent(payload, signature, secret);
    };
    await expect(normalize("checkout.session.completed", { id: "cs_1", object: "checkout.session", mode: "subscription",
      subscription: "sub_1", customer: "cus_1", payment_status: "paid", metadata: { organizationId: "org-1" } }))
      .resolves.toMatchObject({ type: "BillingCheckoutCompleted", organizationId: "org-1", providerSubscriptionId: "sub_1", paymentStatus: "paid" });
    const invoice = { id: "in_1", object: "invoice", customer: "cus_1", amount_paid: 2500, amount_due: 3000,
      currency: "usd", metadata: { organizationId: "wrong-tenant" },
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_1", metadata: { organizationId: "org-1" } } } };
    await expect(normalize("invoice.paid", invoice)).resolves.toMatchObject({ type: "InvoicePaid", organizationId: "org-1",
      providerSubscriptionId: "sub_1", amountMinor: 2500, currency: "usd" });
    await expect(normalize("invoice.payment_failed", invoice)).resolves.toMatchObject({ type: "InvoicePaymentFailed", organizationId: "org-1",
      amountMinor: 3000, currency: "usd" });
    await expect(normalize("invoice.paid", { ...invoice, parent: null, subscription: null })).rejects.toThrow("no subscription identity");
    await expect(normalize("checkout.session.completed", { id: "cs_2", mode: "payment", subscription: null }))
      .rejects.toThrow("not a subscription completion");
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
    const missing = new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "resource_missing", statusCode: 404, message: "No such subscription" });
    await expect(retrieveCurrentStripeSubscription({ secretKey: "sk_test_unit", event,
      lookup: async () => { throw missing; } })).rejects.toBeInstanceOf(BillingSubscriptionNotFound);
  });
});
