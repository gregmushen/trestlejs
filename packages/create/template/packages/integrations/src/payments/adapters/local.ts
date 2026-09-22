import { BillingAlreadyCancelled, BillingPlanUnavailable, BillingSubscriptionNotFound } from "../types.js";
import type { BillingProjectionRepository, BillingService, ChangePlanInput, CheckoutSession, CreateCheckoutInput, CreatePortalInput, PortalSession, SubscriptionCommand, SubscriptionSummary } from "../types.js";

export class InMemoryBillingProjectionRepository implements BillingProjectionRepository {
  readonly subscriptions = new Map<string, SubscriptionSummary>();
  async get(id: string) { return this.subscriptions.get(id) ?? null; }
  async put(value: SubscriptionSummary) { this.subscriptions.set(value.organizationId, value); }
}

export class LocalBillingAdapter implements BillingService {
  constructor(private readonly repository: BillingProjectionRepository, private readonly plans: Record<string, readonly string[]>, private readonly planVersions: Record<string, number> = {}) {}
  async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession> {
    await this.activate({ organizationId: input.organizationId, plan: input.plan });
    return { id: `local_checkout_${input.requestId}`, url: input.successUrl ?? `/settings/billing?checkout=success` };
  }
  async createPortalSession(input: CreatePortalInput): Promise<PortalSession> { return { id: `local_portal_${input.requestId}`, url: input.returnUrl ?? "/settings/billing" }; }
  getSubscription(id: string) { return this.repository.get(id); }
  async cancelSubscription(input: SubscriptionCommand) { const current = await this.required(input.organizationId); if (current.status === "cancelled") throw new BillingAlreadyCancelled("subscription is already cancelled"); await this.repository.put({ ...current, status: "cancelled", cancelAtPeriodEnd: true, entitlements: [] }); }
  async resumeSubscription(input: SubscriptionCommand) { const current = await this.required(input.organizationId); await this.repository.put({ ...current, status: "active", cancelAtPeriodEnd: false, entitlements: [...this.entitlements(current.plan)] }); }
  async changePlan(input: ChangePlanInput) { const current = await this.required(input.organizationId); await this.repository.put({ ...current, plan: input.plan, planVersion: this.planVersions[input.plan] ?? 1, entitlements: [...this.entitlements(input.plan)] }); }
  async activate(input: { organizationId: string; plan: string }) { await this.repository.put({ organizationId: input.organizationId, provider: "local", plan: input.plan, planVersion: this.planVersions[input.plan] ?? 1, status: "active", cancelAtPeriodEnd: false, entitlements: [...this.entitlements(input.plan)] }); }
  async failPayment(input: { organizationId: string }) { const current = await this.required(input.organizationId); await this.repository.put({ ...current, status: "past_due" }); }
  async cancel(input: { organizationId: string }) { await this.cancelSubscription({ ...input, commandId: `local:${input.organizationId}` }); }
  private entitlements(plan: string) { const value = this.plans[plan]; if (!value) throw new BillingPlanUnavailable(`unknown plan ${plan}`); return value; }
  private async required(id: string) { const value = await this.repository.get(id); if (!value) throw new BillingSubscriptionNotFound(`no subscription for ${id}`); return value; }
}
