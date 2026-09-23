import Stripe from "stripe";
import { BillingValidationError } from "./types.js";

export type NormalizedBillingEvent = { id: string; type: "BillingCheckoutCompleted" | "SubscriptionActivated" | "SubscriptionUpdated" | "SubscriptionCancelled" | "SubscriptionPastDue" | "InvoicePaid" | "InvoicePaymentFailed"; organizationId?: string; providerCustomerId?: string; providerSubscriptionId?: string; plan?: string; status?: "active" | "trialing" | "past_due" | "cancelled" | "incomplete"; occurredAt: Date;
  /** Subscription items as the provider reports them; plans are resolved from explicit price mappings, never names. */
  items?: Array<{ id: string; priceId: string; quantity: number }>;
  currentPeriodStart?: Date; currentPeriodEnd?: Date; cancelAtPeriodEnd?: boolean };

export function verifyAndNormalizeStripeEvent(rawBody: string, signature: string, secret: string): NormalizedBillingEvent {
  const stripe = new Stripe("sk_test_webhook_verification_only");
  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  const object = event.data.object as Stripe.Checkout.Session | Stripe.Subscription | Stripe.Invoice;
  const metadata = "metadata" in object ? object.metadata : {};
  const base = { id: event.id, occurredAt: new Date(event.created * 1000), ...(metadata?.organizationId ? { organizationId: metadata.organizationId } : {}), ...(metadata?.plan ? { plan: metadata.plan } : {}) };
  if (event.type === "checkout.session.completed") { const session = object as Stripe.Checkout.Session; return { ...base, type: "BillingCheckoutCompleted", providerCustomerId: String(session.customer), providerSubscriptionId: String(session.subscription) }; }
  if (event.type.startsWith("customer.subscription.")) { const subscription = object as Stripe.Subscription; const status: NonNullable<NormalizedBillingEvent["status"]> = subscription.status === "canceled" ? "cancelled" : subscription.status === "active" || subscription.status === "trialing" || subscription.status === "past_due" || subscription.status === "incomplete" ? subscription.status as NonNullable<NormalizedBillingEvent["status"]> : "incomplete"; const type = status === "cancelled" ? "SubscriptionCancelled" : status === "past_due" ? "SubscriptionPastDue" : event.type === "customer.subscription.created" ? "SubscriptionActivated" : "SubscriptionUpdated"; const items = subscription.items?.data?.map((item) => ({ id: item.id, priceId: item.price.id, quantity: item.quantity ?? 1 })) ?? []; const first = subscription.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number }) | undefined; const periodStart = (subscription as { current_period_start?: number }).current_period_start ?? first?.current_period_start; const periodEnd = (subscription as { current_period_end?: number }).current_period_end ?? first?.current_period_end; return { ...base, type, providerCustomerId: String(subscription.customer), providerSubscriptionId: subscription.id, status, items, cancelAtPeriodEnd: subscription.cancel_at_period_end, ...(periodStart ? { currentPeriodStart: new Date(periodStart * 1000) } : {}), ...(periodEnd ? { currentPeriodEnd: new Date(periodEnd * 1000) } : {}) }; }
  if (event.type === "invoice.paid") return { ...base, type: "InvoicePaid" };
  if (event.type === "invoice.payment_failed") return { ...base, type: "InvoicePaymentFailed" };
  throw new BillingValidationError(`unsupported Stripe event ${event.type}`);
}
