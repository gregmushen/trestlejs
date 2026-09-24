import Stripe from "stripe";
import { BillingAlreadyCancelled, BillingConfigurationError, BillingPlanUnavailable, BillingProviderUnavailable, BillingRateLimited, BillingSubscriptionNotFound, BillingValidationError } from "../types.js";
import type { BillingProjectionRepository, BillingService, ChangePlanInput, CheckoutSession, CreateCheckoutInput, CreatePortalInput, PortalSession, SubscriptionCommand } from "../types.js";

export type StripeBillingOptions = { secretKey: string; prices: Record<string, string>; returnUrl: string; repository: BillingProjectionRepository };

function normalized(error: unknown): Error {
  if (!(error instanceof Stripe.errors.StripeError)) return new BillingProviderUnavailable(error instanceof Error ? error.message : String(error));
  if (error.type === "StripeRateLimitError") return new BillingRateLimited(error.message);
  if (error.type === "StripeInvalidRequestError") return new BillingValidationError(error.message);
  return new BillingProviderUnavailable(error.message);
}

export class StripeBillingAdapter implements BillingService {
  private readonly stripe: Stripe;
  constructor(private readonly options: StripeBillingOptions) { if (!options.secretKey) throw new BillingConfigurationError("STRIPE_SECRET_KEY is required"); this.stripe = new Stripe(options.secretKey); }
  async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const price = this.options.prices[input.plan]; if (!price) throw new BillingPlanUnavailable(`no Stripe price is mapped for ${input.plan}`);
    try {
      const metadata = { organizationId: input.organizationId, plan: input.plan };
      const session = await this.stripe.checkout.sessions.create({ mode: "subscription", line_items: [{ price, quantity: 1 }], success_url: input.successUrl ?? `${this.options.returnUrl}?checkout=success`, cancel_url: input.cancelUrl ?? `${this.options.returnUrl}?checkout=cancelled`, ...(input.customerEmail ? { customer_email: input.customerEmail } : {}), metadata, subscription_data: { metadata } }, { idempotencyKey: `checkout:${input.organizationId}:${input.plan}:${input.requestId}` });
      if (!session.url) throw new BillingProviderUnavailable("Stripe did not return a Checkout URL");
      return { id: session.id, url: session.url, ...(session.expires_at ? { expiresAt: new Date(session.expires_at * 1000) } : {}) };
    } catch (error) { throw normalized(error); }
  }
  async createPortalSession(input: CreatePortalInput): Promise<PortalSession> {
    const subscription = await this.required(input.organizationId); if (!subscription.providerCustomerId) throw new BillingSubscriptionNotFound("subscription has no provider customer");
    try { const session = await this.stripe.billingPortal.sessions.create({ customer: subscription.providerCustomerId, return_url: input.returnUrl ?? this.options.returnUrl }, { idempotencyKey: `portal:${input.organizationId}:${input.requestId}` }); return { id: session.id, url: session.url }; } catch (error) { throw normalized(error); }
  }
  getSubscription(id: string) { return this.options.repository.get(id); }
  async cancelSubscription(input: SubscriptionCommand) { const current = await this.required(input.organizationId); if (current.cancelAtPeriodEnd) throw new BillingAlreadyCancelled("subscription is already set to cancel"); await this.update(current.providerSubscriptionId, { cancel_at_period_end: true }, `cancel:${current.providerSubscriptionId}:${input.commandId}`); }
  async resumeSubscription(input: SubscriptionCommand) { const current = await this.required(input.organizationId); await this.update(current.providerSubscriptionId, { cancel_at_period_end: false }, `resume:${current.providerSubscriptionId}:${input.commandId}`); }
  async changePlan(input: ChangePlanInput) { const current = await this.required(input.organizationId); const price = this.options.prices[input.plan]; if (!price) throw new BillingPlanUnavailable(`no Stripe price is mapped for ${input.plan}`); if (!current.providerSubscriptionId) throw new BillingSubscriptionNotFound("subscription has no provider ID"); try { const subscription = await this.stripe.subscriptions.retrieve(current.providerSubscriptionId); const item = subscription.items.data[0]; if (!item) throw new BillingSubscriptionNotFound("subscription has no item"); await this.stripe.subscriptions.update(subscription.id, { items: [{ id: item.id, price }], metadata: { organizationId: input.organizationId, plan: input.plan } }, { idempotencyKey: `plan-change:${subscription.id}:${input.plan}:${input.commandId}` }); } catch (error) { throw normalized(error); } }
  private async required(id: string) { const value = await this.options.repository.get(id); if (!value) throw new BillingSubscriptionNotFound(`no subscription for ${id}`); return value; }
  private async update(id: string | undefined, params: Stripe.SubscriptionUpdateParams, key: string) { if (!id) throw new BillingSubscriptionNotFound("subscription has no provider ID"); try { await this.stripe.subscriptions.update(id, params, { idempotencyKey: key }); } catch (error) { throw normalized(error); } }
}
