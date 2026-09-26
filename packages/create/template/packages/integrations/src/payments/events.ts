import Stripe from "stripe";

import { BillingProviderUnavailable, BillingSubscriptionNotFound, BillingValidationError } from "./types.js";

export type NormalizedBillingEvent = { id: string; type: "BillingCheckoutCompleted" | "SubscriptionActivated" | "SubscriptionUpdated" | "SubscriptionCancelled" | "SubscriptionPastDue" | "InvoicePaid" | "InvoicePaymentFailed"; organizationId?: string; providerCustomerId?: string; providerSubscriptionId?: string; plan?: string; status?: "active" | "trialing" | "past_due" | "cancelled" | "incomplete"; cancelAtPeriodEnd?: boolean; currentPeriodStart?: Date; currentPeriodEnd?: Date; amountMinor?: number; currency?: string; paymentStatus?: "paid" | "unpaid" | "no_payment_required"; occurredAt: Date };

function providerId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") return value.id;
  return undefined;
}

function normalizeSubscription(subscription: Stripe.Subscription, base: Pick<NormalizedBillingEvent, "id" | "occurredAt">, sourceType: string): NormalizedBillingEvent {
  const metadata = subscription.metadata;
  const status: NonNullable<NormalizedBillingEvent["status"]> = subscription.status === "canceled" ? "cancelled"
    : subscription.status === "active" || subscription.status === "trialing" || subscription.status === "past_due" || subscription.status === "incomplete"
      ? subscription.status as NonNullable<NormalizedBillingEvent["status"]> : "incomplete";
  const type = status === "cancelled" ? "SubscriptionCancelled" : status === "past_due" ? "SubscriptionPastDue"
    : sourceType === "customer.subscription.created" ? "SubscriptionActivated" : "SubscriptionUpdated";
  const period = subscription.items?.data[0];
  return { ...base, type, providerCustomerId: String(subscription.customer), providerSubscriptionId: subscription.id,
    ...(metadata?.organizationId ? { organizationId: metadata.organizationId } : {}),
    ...(metadata?.plan ? { plan: metadata.plan } : {}),
    status, cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    ...(period?.current_period_start ? { currentPeriodStart: new Date(period.current_period_start * 1000) } : {}),
    ...(period?.current_period_end ? { currentPeriodEnd: new Date(period.current_period_end * 1000) } : {}),
  };
}

export async function verifyAndNormalizeStripeEvent(rawBody: string, signature: string, secret: string): Promise<NormalizedBillingEvent> {
  const stripe = new Stripe("sk_test_webhook_verification_only");
  const event = await stripe.webhooks.constructEventAsync(rawBody, signature, secret, undefined, Stripe.createSubtleCryptoProvider());
  const object = event.data.object as Stripe.Checkout.Session | Stripe.Subscription | Stripe.Invoice;
  const base = { id: event.id, occurredAt: new Date(event.created * 1000) };
  if (event.type === "checkout.session.completed") {
    const session = object as Stripe.Checkout.Session;
    const subscriptionId = providerId(session.subscription);
    const customerId = providerId(session.customer);
    const paymentStatus = session.payment_status === "paid" ? "paid" : session.payment_status === "unpaid" ? "unpaid"
      : session.payment_status === "no_payment_required" ? "no_payment_required" : undefined;
    if (session.mode !== "subscription" || !subscriptionId?.startsWith("sub_")) throw new BillingValidationError("Checkout event is not a subscription completion");
    return { ...base, type: "BillingCheckoutCompleted", providerSubscriptionId: subscriptionId,
      ...(customerId ? { providerCustomerId: customerId } : {}),
      ...(session.metadata?.organizationId ? { organizationId: session.metadata.organizationId } : {}),
      ...(paymentStatus ? { paymentStatus } : {}),
    };
  }
  if (event.type.startsWith("customer.subscription.")) return normalizeSubscription(object as Stripe.Subscription, base, event.type);
  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const invoice = object as Stripe.Invoice;
    const subscriptionDetails = invoice.parent?.subscription_details;
    const subscriptionId = providerId(subscriptionDetails?.subscription)
      ?? providerId((invoice as Stripe.Invoice & { subscription?: unknown }).subscription);
    const customerId = providerId(invoice.customer);
    if (!subscriptionId?.startsWith("sub_")) throw new BillingValidationError("Invoice event has no subscription identity");
    const amount = event.type === "invoice.paid" ? invoice.amount_paid : invoice.amount_due;
    if (!Number.isSafeInteger(amount) || !/^[a-z]{3}$/u.test(invoice.currency)) throw new BillingValidationError("Invoice amount or currency is invalid");
    return { ...base, type: event.type === "invoice.paid" ? "InvoicePaid" : "InvoicePaymentFailed",
      providerSubscriptionId: subscriptionId, amountMinor: amount, currency: invoice.currency,
      ...(customerId ? { providerCustomerId: customerId } : {}),
      ...(subscriptionDetails?.metadata?.organizationId ? { organizationId: subscriptionDetails.metadata.organizationId } : {}),
    };
  }
  throw new BillingValidationError(`unsupported Stripe event ${event.type}`);
}

/** Webhooks are notifications, not ordered snapshots. The current provider
 * subscription is fetched before an entitlement projection is attempted.
 * Throws `BillingSubscriptionNotFound` only when Stripe reports the
 * subscription missing, and `BillingProviderUnavailable` for anything else. */
export async function retrieveCurrentStripeSubscription(input: {
  secretKey: string;
  event: NormalizedBillingEvent;
  lookup?: (id: string) => Promise<Stripe.Subscription>;
}): Promise<NormalizedBillingEvent> {
  const id = input.event.providerSubscriptionId;
  if (!id || !id.startsWith("sub_") || !input.secretKey) throw new BillingValidationError("Subscription reconciliation is not configured");
  try {
    const subscription = await (input.lookup ?? ((subscriptionId: string) => new Stripe(input.secretKey, { httpClient: Stripe.createFetchHttpClient() }).subscriptions.retrieve(subscriptionId)))(id);
    if (subscription.id !== id) throw new BillingValidationError("Subscription lookup returned a different provider identity");
    return normalizeSubscription(subscription, { id: input.event.id, occurredAt: input.event.occurredAt }, input.event.type === "SubscriptionActivated" ? "customer.subscription.created" : "customer.subscription.updated");
  } catch (error) {
    if (error instanceof BillingValidationError) throw error;
    // Only Stripe's explicit "no such subscription" is terminal; everything else stays retryable.
    if (error instanceof Stripe.errors.StripeError && error.statusCode === 404 && error.code === "resource_missing") {
      throw new BillingSubscriptionNotFound("Stripe subscription does not exist");
    }
    throw new BillingProviderUnavailable("Stripe subscription reconciliation is unavailable");
  }
}
