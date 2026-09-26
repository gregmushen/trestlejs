import { BillingAlreadyCancelled, BillingPlanUnavailable, BillingSubscriptionNotFound } from "../types.js";
import type { BillingProjectionRepository, BillingService, BillingStatus, ChangePlanInput, CheckoutSession, CreateCheckoutInput, CreatePortalInput, PortalSession, SubscriptionCommand, SubscriptionSummary } from "../types.js";
import type { NormalizedBillingEvent } from "../events.js";

export class InMemoryBillingProjectionRepository implements BillingProjectionRepository {
  readonly subscriptions = new Map<string, SubscriptionSummary>();
  async get(id: string) { return this.subscriptions.get(id) ?? null; }
  async put(value: SubscriptionSummary) { this.subscriptions.set(value.organizationId, value); }
}

/** The local provider's own record of a subscription: the local stand-in for
 * what Stripe returns from a subscription lookup. It is provider state, not
 * the application's billing projection. */
export type LocalProviderSubscription = {
  provider: string;
  providerSubscriptionId: string;
  organizationId?: string;
  providerCustomerId?: string;
  plan?: string;
  status: BillingStatus;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
};

export interface LocalBillingProviderStore {
  get(provider: string, providerSubscriptionId: string): Promise<LocalProviderSubscription | null>;
  put(value: LocalProviderSubscription): Promise<void>;
}

export class InMemoryLocalBillingProvider implements LocalBillingProviderStore {
  readonly subscriptions = new Map<string, LocalProviderSubscription>();
  async get(provider: string, providerSubscriptionId: string) {
    const value = this.subscriptions.get(`${provider}:${providerSubscriptionId}`);
    return value ? { ...value } : null;
  }
  async put(value: LocalProviderSubscription) { this.subscriptions.set(`${value.provider}:${value.providerSubscriptionId}`, { ...value }); }
}

/** A local provider notification, shaped like a verified Stripe subscription webhook. */
export type LocalBillingNotification = {
  provider: "local";
  providerEventId: string;
  providerSubscriptionId: string;
  type: Extract<NormalizedBillingEvent["type"], `Subscription${string}`>;
  occurredAt: Date;
};

/** Read the local provider's current subscription the way the Stripe adapter
 * retrieves one: the notification only says what to look up. */
export async function retrieveCurrentLocalSubscription(store: LocalBillingProviderStore, event: Pick<NormalizedBillingEvent, "id" | "type" | "providerSubscriptionId" | "occurredAt">, provider = "local"): Promise<NormalizedBillingEvent> {
  const id = event.providerSubscriptionId;
  if (!id) throw new BillingSubscriptionNotFound("local subscription identity is missing");
  const current = await store.get(provider, id);
  if (!current) throw new BillingSubscriptionNotFound(`no local subscription ${id}`);
  const type: NormalizedBillingEvent["type"] = current.status === "cancelled" ? "SubscriptionCancelled"
    : current.status === "past_due" ? "SubscriptionPastDue"
      : event.type === "SubscriptionActivated" ? "SubscriptionActivated" : "SubscriptionUpdated";
  return { id: event.id, occurredAt: event.occurredAt, type, providerSubscriptionId: id, status: current.status,
    cancelAtPeriodEnd: current.cancelAtPeriodEnd,
    ...(current.organizationId ? { organizationId: current.organizationId } : {}),
    ...(current.providerCustomerId ? { providerCustomerId: current.providerCustomerId } : {}),
    ...(current.plan ? { plan: current.plan } : {}),
    ...(current.currentPeriodStart ? { currentPeriodStart: current.currentPeriodStart } : {}),
    ...(current.currentPeriodEnd ? { currentPeriodEnd: current.currentPeriodEnd } : {}),
  };
}

export type LocalBillingOptions = {
  /** Local provider state: what a reconciliation reads back. */
  provider: LocalBillingProviderStore;
  /** The application's billing projection, read by `getSubscription`. */
  repository: BillingProjectionRepository;
  plans: Record<string, readonly string[]>;
  /** Deliver a provider notification. The Worker records a durable receipt and
   * runs the same reconciler as Stripe; the adapter never writes the projection. */
  notify: (notification: LocalBillingNotification) => Promise<void>;
  clock?: { now(): Date };
};

/** One deterministic local subscription per organization. */
export function localSubscriptionId(organizationId: string): string { return `sub_local_${organizationId}`; }

/** A deterministic provider without a Stripe account. Every change updates
 * local provider state and then notifies, so local billing follows the same
 * receipt → durable request → reconcile path as Stripe. */
export class LocalBillingAdapter implements BillingService {
  constructor(private readonly options: LocalBillingOptions) {}
  async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession> {
    await this.activate({ organizationId: input.organizationId, plan: input.plan });
    return { id: `local_checkout_${input.requestId}`, url: input.successUrl ?? `/settings/billing?checkout=success` };
  }
  async createPortalSession(input: CreatePortalInput): Promise<PortalSession> { return { id: `local_portal_${input.requestId}`, url: input.returnUrl ?? "/settings/billing" }; }
  getSubscription(id: string) { return this.options.repository.get(id); }
  async cancelSubscription(input: SubscriptionCommand) {
    const current = await this.required(input.organizationId);
    if (current.status === "cancelled") throw new BillingAlreadyCancelled("subscription is already cancelled");
    await this.change({ ...current, status: "cancelled", cancelAtPeriodEnd: true }, "SubscriptionCancelled");
  }
  async resumeSubscription(input: SubscriptionCommand) {
    const current = await this.required(input.organizationId);
    await this.change({ ...current, status: "active", cancelAtPeriodEnd: false }, "SubscriptionUpdated");
  }
  async changePlan(input: ChangePlanInput) {
    this.requirePlan(input.plan);
    const current = await this.required(input.organizationId);
    await this.change({ ...current, plan: input.plan }, "SubscriptionUpdated");
  }
  async activate(input: { organizationId: string; plan: string }) {
    this.requirePlan(input.plan);
    const providerSubscriptionId = localSubscriptionId(input.organizationId);
    const current = await this.options.provider.get("local", providerSubscriptionId);
    await this.change({ provider: "local", providerSubscriptionId, organizationId: input.organizationId,
      providerCustomerId: `cus_local_${input.organizationId}`, plan: input.plan, status: "active", cancelAtPeriodEnd: false },
    current ? "SubscriptionUpdated" : "SubscriptionActivated");
  }
  async failPayment(input: { organizationId: string }) {
    const current = await this.required(input.organizationId);
    await this.change({ ...current, status: "past_due" }, "SubscriptionPastDue");
  }
  async cancel(input: { organizationId: string }) { await this.cancelSubscription({ ...input, commandId: `local:${input.organizationId}` }); }
  private async change(next: LocalProviderSubscription, type: LocalBillingNotification["type"]) {
    await this.options.provider.put(next);
    await this.options.notify({ provider: "local", providerEventId: `evt_local_${crypto.randomUUID().replaceAll("-", "")}`,
      providerSubscriptionId: next.providerSubscriptionId, type, occurredAt: this.options.clock?.now() ?? new Date() });
  }
  private requirePlan(plan: string) { if (!this.options.plans[plan]) throw new BillingPlanUnavailable(`unknown plan ${plan}`); }
  private async required(organizationId: string) {
    const value = await this.options.provider.get("local", localSubscriptionId(organizationId));
    if (!value) throw new BillingSubscriptionNotFound(`no subscription for ${organizationId}`);
    return value;
  }
}
