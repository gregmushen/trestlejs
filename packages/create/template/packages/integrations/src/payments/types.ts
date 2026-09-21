export type BillingStatus = "active" | "trialing" | "past_due" | "cancelled" | "incomplete";
export type SubscriptionSummary = { organizationId: string; provider: string; providerCustomerId?: string; providerSubscriptionId?: string; plan: string; status: BillingStatus; currentPeriodStart?: Date; currentPeriodEnd?: Date; cancelAtPeriodEnd: boolean; entitlements: string[] };
export type CreateCheckoutInput = { organizationId: string; plan: string; requestId: string; customerEmail?: string; successUrl?: string; cancelUrl?: string };
export type CheckoutSession = { id: string; url: string; expiresAt?: Date };
export type CreatePortalInput = { organizationId: string; requestId: string; returnUrl?: string };
export type PortalSession = { id: string; url: string };
export type SubscriptionCommand = { organizationId: string; commandId: string };
export type ChangePlanInput = SubscriptionCommand & { plan: string };

export interface BillingProjectionRepository {
  get(organizationId: string): Promise<SubscriptionSummary | null>;
  put(subscription: SubscriptionSummary): Promise<void>;
}

export interface BillingService {
  createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession>;
  createPortalSession(input: CreatePortalInput): Promise<PortalSession>;
  getSubscription(organizationId: string): Promise<SubscriptionSummary | null>;
  cancelSubscription(input: SubscriptionCommand): Promise<void>;
  resumeSubscription(input: SubscriptionCommand): Promise<void>;
  changePlan(input: ChangePlanInput): Promise<void>;
}

export class BillingValidationError extends Error {}
export class BillingProviderUnavailable extends Error {}
export class BillingRateLimited extends Error {}
export class BillingConfigurationError extends Error {}
export class BillingSubscriptionNotFound extends Error {}
export class BillingPlanUnavailable extends Error {}
export class BillingAlreadyCancelled extends Error {}
