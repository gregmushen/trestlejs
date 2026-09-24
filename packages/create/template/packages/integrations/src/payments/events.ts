import Stripe from "stripe";

import { BillingProviderUnavailable, BillingValidationError } from "./types.js";

export type NormalizedBillingEvent = { id: string; type: "BillingCheckoutCompleted" | "SubscriptionActivated" | "SubscriptionUpdated" | "SubscriptionCancelled" | "SubscriptionPastDue" | "InvoicePaid" | "InvoicePaymentFailed"; organizationId?: string; providerCustomerId?: string; providerSubscriptionId?: string; plan?: string; status?: "active" | "trialing" | "past_due" | "cancelled" | "incomplete"; cancelAtPeriodEnd?: boolean; currentPeriodStart?: Date; currentPeriodEnd?: Date; occurredAt: Date };

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

export function verifyAndNormalizeStripeEvent(rawBody: string, signature: string, secret: string): NormalizedBillingEvent {
  const stripe = new Stripe("sk_test_webhook_verification_only");
  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  const object = event.data.object as Stripe.Checkout.Session | Stripe.Subscription | Stripe.Invoice;
  const metadata = "metadata" in object ? object.metadata : {};
  const base = { id: event.id, occurredAt: new Date(event.created * 1000),
    ...(metadata?.organizationId ? { organizationId: metadata.organizationId } : {}),
    ...(metadata?.plan ? { plan: metadata.plan } : {}),
  };
  if (event.type === "checkout.session.completed") {
    const session = object as Stripe.Checkout.Session;
    return { ...base, type: "BillingCheckoutCompleted", providerCustomerId: String(session.customer), providerSubscriptionId: String(session.subscription) };
  }
  if (event.type.startsWith("customer.subscription.")) return normalizeSubscription(object as Stripe.Subscription, base, event.type);
  if (event.type === "invoice.paid") return { ...base, type: "InvoicePaid" };
  if (event.type === "invoice.payment_failed") return { ...base, type: "InvoicePaymentFailed" };
  throw new BillingValidationError(`unsupported Stripe event ${event.type}`);
}

/** Webhooks are notifications, not ordered snapshots. The current provider
 * subscription is fetched before an entitlement projection is attempted. */
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
    throw new BillingProviderUnavailable("Stripe subscription reconciliation is unavailable");
  }
}
