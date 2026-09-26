import {
  billingLocalSubscription,
  claimBillingSubscriptionReconciliation,
  completeBillingSubscriptionReconciliation,
  createDatabase,
  outboxApplicationConnectionString,
  requestBillingSubscriptionReconciliation,
  type BillingReconciliationOutcome,
  type BillingReconciliationResult,
  type DatabaseDriver,
} from "@__TRESTLE_PROJECT_NAME__/db";
import {
  BillingProviderUnavailable,
  BillingSubscriptionNotFound,
  retrieveCurrentLocalSubscription,
  type BillingStatus,
  type LocalBillingNotification,
  type LocalBillingProviderStore,
  type LocalProviderSubscription,
  type NormalizedBillingEvent,
} from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq } from "drizzle-orm";

import { getPlan, planEntitlements } from "./plans.js";

/** Read the provider's current subscription. Throw `BillingSubscriptionNotFound`
 * only when the provider says it does not exist; any other error is retryable. */
export type BillingSubscriptionLookup = (request: {
  provider: string;
  providerSubscriptionId: string;
  providerEventId: string;
  type: NormalizedBillingEvent["type"];
  occurredAt: Date;
}) => Promise<NormalizedBillingEvent>;

export type BillingReconciliationRun = {
  /** `idle`: nothing left due. `busy`: another live lease holds the work, so
   * retry later. `due`: work remains after `maxPasses`. `fenced`: a newer
   * claim took over after this one's lease expired; it committed nothing. */
  state: "idle" | "busy" | "due" | "fenced";
  outcomes: BillingReconciliationOutcome[];
};

/**
 * Reconcile one provider subscription from its durable request. Each pass
 * leases the request, asks the provider for current state outside any
 * database transaction, then commits only if it still holds the lease. A
 * receipt that arrives during a pass leaves the work due, so another pass
 * follows. Provider failure keeps the last confirmed projection, leaves the
 * work due and rethrows `BillingProviderUnavailable`; a missing subscription
 * or one without a known organization and plan is rejected, not guessed.
 */
export async function reconcileBillingSubscription(input: {
  databaseUrl: string;
  driver?: DatabaseDriver;
  provider: string;
  providerSubscriptionId: string;
  lookup: BillingSubscriptionLookup;
  leaseMs?: number;
  maxPasses?: number;
}): Promise<BillingReconciliationRun> {
  const outcomes: BillingReconciliationOutcome[] = [];
  const maxPasses = input.maxPasses ?? 5;
  const connection = { databaseUrl: input.databaseUrl, ...(input.driver ? { driver: input.driver } : {}) };
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const claimed = await claimBillingSubscriptionReconciliation({ ...connection, provider: input.provider,
      providerSubscriptionId: input.providerSubscriptionId, ...(input.leaseMs ? { leaseMs: input.leaseMs } : {}) });
    if (claimed.state !== "claimed") return { state: claimed.state, outcomes };
    const { claim } = claimed;
    let result: BillingReconciliationResult;
    try {
      const current = await input.lookup({ provider: claim.provider, providerSubscriptionId: claim.providerSubscriptionId,
        providerEventId: claim.providerEventId, type: claim.type as NormalizedBillingEvent["type"], occurredAt: claim.occurredAt });
      result = currentProjection(current, claim.providerSubscriptionId);
    } catch (error) {
      if (error instanceof BillingSubscriptionNotFound) result = { kind: "terminal", reason: "not_found" };
      else {
        const released = await completeBillingSubscriptionReconciliation({ ...connection, claim, result: { kind: "unavailable" } });
        if (released.outcome === "fenced") return { state: "fenced", outcomes: [...outcomes, "fenced"] };
        throw error instanceof BillingProviderUnavailable ? error : new BillingProviderUnavailable("Billing provider reconciliation is unavailable");
      }
    }
    const completed = await completeBillingSubscriptionReconciliation({ ...connection, claim, result });
    outcomes.push(completed.outcome);
    if (completed.outcome === "fenced") return { state: "fenced", outcomes };
    if (!completed.due) return { state: "idle", outcomes };
  }
  return { state: "due", outcomes };
}

/** Map current provider state to a projection only when both the organization
 * and the plan are known. Ownership is still checked against the immutable
 * binding when the projection commits. */
function currentProjection(current: NormalizedBillingEvent, providerSubscriptionId: string): BillingReconciliationResult {
  if (current.providerSubscriptionId !== providerSubscriptionId) throw new BillingProviderUnavailable("Billing provider returned a different subscription");
  const plan = current.plan ? getPlan(current.plan) : undefined;
  if (!current.organizationId || !/^[A-Za-z0-9_-]+$/u.test(current.organizationId) || !current.plan || !plan || !current.status) {
    return { kind: "terminal", reason: "unmapped" };
  }
  return { kind: "current", projection: {
    organizationId: current.organizationId,
    ...(current.providerCustomerId ? { providerCustomerId: current.providerCustomerId } : {}),
    providerSubscriptionId,
    plan: current.plan, planVersion: plan.version, status: current.status,
    ...(current.cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd: current.cancelAtPeriodEnd } : {}),
    ...(current.currentPeriodStart ? { currentPeriodStart: current.currentPeriodStart } : {}),
    ...(current.currentPeriodEnd ? { currentPeriodEnd: current.currentPeriodEnd } : {}),
    entitlements: current.status === "active" || current.status === "trialing" ? [...(planEntitlements[current.plan as keyof typeof planEntitlements] ?? [])] : [],
  } };
}

/** Local provider state in PostgreSQL, so every Worker request and test sees
 * the same deterministic provider. */
export class PostgresLocalBillingProvider implements LocalBillingProviderStore {
  constructor(private readonly databaseUrl: string, private readonly driver?: DatabaseDriver) {}
  private database() { return createDatabase(outboxApplicationConnectionString(this.databaseUrl), this.driver); }
  async get(provider: string, providerSubscriptionId: string): Promise<LocalProviderSubscription | null> {
    const [row] = await this.database().select().from(billingLocalSubscription).where(and(eq(billingLocalSubscription.provider, provider),
      eq(billingLocalSubscription.providerSubscriptionId, providerSubscriptionId))).limit(1);
    if (!row) return null;
    return { provider: row.provider, providerSubscriptionId: row.providerSubscriptionId, status: row.status as BillingStatus, cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      ...(row.organizationId ? { organizationId: row.organizationId } : {}), ...(row.providerCustomerId ? { providerCustomerId: row.providerCustomerId } : {}),
      ...(row.plan ? { plan: row.plan } : {}), ...(row.currentPeriodStart ? { currentPeriodStart: row.currentPeriodStart } : {}),
      ...(row.currentPeriodEnd ? { currentPeriodEnd: row.currentPeriodEnd } : {}) };
  }
  async put(value: LocalProviderSubscription): Promise<void> {
    const row = { organizationId: value.organizationId ?? null, providerCustomerId: value.providerCustomerId ?? null, plan: value.plan ?? null,
      status: value.status, cancelAtPeriodEnd: value.cancelAtPeriodEnd, currentPeriodStart: value.currentPeriodStart ?? null,
      currentPeriodEnd: value.currentPeriodEnd ?? null, updatedAt: new Date() };
    await this.database().insert(billingLocalSubscription).values({ provider: value.provider, providerSubscriptionId: value.providerSubscriptionId, ...row })
      .onConflictDoUpdate({ target: [billingLocalSubscription.provider, billingLocalSubscription.providerSubscriptionId], set: row });
  }
}

/** A lookup that reads the local provider, for local mode and signed local fixtures. */
export function localBillingLookup(store: LocalBillingProviderStore): BillingSubscriptionLookup {
  return async (request) => await retrieveCurrentLocalSubscription(store, { id: request.providerEventId, type: request.type,
    providerSubscriptionId: request.providerSubscriptionId, occurredAt: request.occurredAt }, request.provider);
}

/**
 * The local adapter's `notify`: record the receipt and durable request, then
 * run the same reconciler inline so local billing is deterministic. Another
 * live lease or a lookup failure is surfaced as `BillingProviderUnavailable`,
 * leaving the request due.
 */
export function createLocalBillingNotifier(input: { databaseUrl: string; driver?: DatabaseDriver; store: LocalBillingProviderStore; correlationId?: string }) {
  const connection = { databaseUrl: input.databaseUrl, ...(input.driver ? { driver: input.driver } : {}) };
  return async (notification: LocalBillingNotification): Promise<void> => {
    await requestBillingSubscriptionReconciliation({ ...connection, provider: notification.provider, providerEventId: notification.providerEventId,
      providerSubscriptionId: notification.providerSubscriptionId, type: notification.type, correlationId: input.correlationId ?? notification.providerEventId });
    const run = await reconcileBillingSubscription({ ...connection, provider: notification.provider,
      providerSubscriptionId: notification.providerSubscriptionId, lookup: localBillingLookup(input.store) });
    if (run.state === "busy" || run.state === "due") throw new BillingProviderUnavailable("Local billing reconciliation is still in progress");
  };
}
