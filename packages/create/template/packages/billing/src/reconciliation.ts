import type { BillingStatus, SubscriptionSummary } from "@__TRESTLE_PROJECT_NAME__/integrations";

/** A normalized, provider-neutral snapshot fetched by an adapter. */
export type ProviderSubscriptionSnapshot = Readonly<{
  organizationId: string;
  provider: string;
  providerSubscriptionId?: string;
  plan: string;
  status: BillingStatus;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd: boolean;
}>;

export type ReconciliationDifference = Readonly<{ field: "plan" | "status" | "providerSubscriptionId" | "currentPeriodEnd" | "cancelAtPeriodEnd"; local: string | null; provider: string | null }>;

export type ReconciliationResult = Readonly<{
  organizationId: string;
  outcome: "in_sync" | "drift" | "missing_local" | "missing_provider";
  differences: ReconciliationDifference[];
  /** The provider-derived projection to write when an operator accepts the repair. */
  repair?: Omit<SubscriptionSummary, "entitlements">;
}>;

const text = (value: unknown): string | null => value === undefined || value === null ? null : value instanceof Date ? value.toISOString() : String(value);

export function reconcileSubscription(organizationId: string, local: SubscriptionSummary | null, provider: ProviderSubscriptionSnapshot | null): ReconciliationResult {
  if (!local && !provider) return { organizationId, outcome: "in_sync", differences: [] };
  if (!provider) return { organizationId, outcome: "missing_provider", differences: [] };
  const repair = {
    organizationId,
    provider: provider.provider,
    ...(provider.providerSubscriptionId ? { providerSubscriptionId: provider.providerSubscriptionId } : {}),
    ...(local?.providerCustomerId ? { providerCustomerId: local.providerCustomerId } : {}),
    plan: provider.plan,
    status: provider.status,
    ...(provider.currentPeriodEnd ? { currentPeriodEnd: provider.currentPeriodEnd } : {}),
    cancelAtPeriodEnd: provider.cancelAtPeriodEnd,
  };
  if (!local) return { organizationId, outcome: "missing_local", differences: [], repair };
  const differences = (["plan", "status", "providerSubscriptionId", "currentPeriodEnd", "cancelAtPeriodEnd"] as const)
    .map((field) => ({ field, local: text(local[field]), provider: text(provider[field]) }))
    .filter((difference) => difference.local !== difference.provider);
  return differences.length ? { organizationId, outcome: "drift", differences, repair } : { organizationId, outcome: "in_sync", differences };
}
