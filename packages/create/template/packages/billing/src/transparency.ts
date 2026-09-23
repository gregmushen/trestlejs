import type { BillingStatus, SubscriptionSummary } from "@__TRESTLE_PROJECT_NAME__/integrations";

import type { EffectiveEntitlement } from "./effective.js";
import type { FeatureCatalog, PrivilegeValue } from "./features.js";
import { planVersionRef, type PlanVersion } from "./plans.js";
import type { QuotaState } from "./usage.js";

export type ScheduledPlanChange = Readonly<{ id: string; organizationId: string; toPlanVersion: string; effectiveAt: Date; appliedAt?: Date | null; cancelledAt?: Date | null }>;

/**
 * The customer-safe capability document. It contains no provider payloads or
 * identifiers, override reasons or authors, or platform policy.
 */
export type TenantCapabilityDocument = Readonly<{
  plan: null | { key: string; name: string; version: string; status: BillingStatus; renewsAt?: string; cancelAtPeriodEnd: boolean };
  capabilities: Array<{ code: string; name: string; description: string; enabled: boolean; values: Readonly<Record<string, PrivilegeValue>>; source: "plan" | "contract"; includedWith?: string }>;
  limits: Array<{ code: string; name: string; used: number; included: number; limit: number | null; resetsAt: string; enforcement: "hard" | "soft" }>;
  contractualOverrides: Array<{ code: string; name: string; effectiveAt: string; expiresAt?: string }>;
  scheduledChanges: Array<{ toPlan: string; effectiveAt: string }>;
  upgrades: Array<{ code: string; name: string; availableOn: string[] }>;
  /** Plans a customer can subscribe to now, with their headline capabilities. */
  availablePlans: Array<{ key: string; name: string; version: string; current: boolean; capabilities: string[] }>;
}>;

export function tenantCapabilityDocument(input: {
  catalog: FeatureCatalog;
  subscription: SubscriptionSummary | null;
  planVersion: PlanVersion | null;
  effective: readonly EffectiveEntitlement[];
  quotas?: readonly QuotaState[];
  scheduledChanges?: readonly ScheduledPlanChange[];
  offeredPlans?: readonly PlanVersion[];
}): TenantCapabilityDocument {
  const nameOf = (code: string) => input.catalog.get(code)?.name ?? code;
  const planName = input.planVersion?.name;
  const enabled = new Set(input.effective.filter((entry) => entry.enabled).map((entry) => entry.code));
  return {
    plan: input.subscription && input.planVersion ? {
      key: input.planVersion.plan,
      name: input.planVersion.name,
      version: planVersionRef(input.planVersion),
      status: input.subscription.status,
      ...(input.subscription.currentPeriodEnd ? { renewsAt: input.subscription.currentPeriodEnd.toISOString() } : {}),
      cancelAtPeriodEnd: input.subscription.cancelAtPeriodEnd,
    } : null,
    capabilities: input.effective.map((entry) => ({
      code: entry.code,
      name: nameOf(entry.code),
      description: input.catalog.get(entry.code)?.description ?? "",
      enabled: entry.enabled,
      values: entry.values,
      source: entry.source === "subscription_override" ? "contract" as const : "plan" as const,
      ...(entry.source === "plan" && planName ? { includedWith: planName } : {}),
    })),
    limits: (input.quotas ?? []).map((quota) => ({ code: quota.code, name: nameOf(quota.code), used: quota.used, included: quota.included, limit: quota.limit, resetsAt: quota.period.end, enforcement: quota.enforcement })),
    contractualOverrides: input.effective.filter((entry) => entry.source === "subscription_override").map((entry) => ({ code: entry.code, name: nameOf(entry.code), effectiveAt: entry.effectiveAt, ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}) })),
    scheduledChanges: (input.scheduledChanges ?? []).filter((change) => !change.appliedAt && !change.cancelledAt).map((change) => ({ toPlan: change.toPlanVersion, effectiveAt: change.effectiveAt.toISOString() })),
    upgrades: input.catalog.list().filter((feature) => !enabled.has(feature.code)).map((feature) => ({
      code: feature.code,
      name: feature.name,
      availableOn: (input.offeredPlans ?? []).filter((plan) => plan.state === "active" && feature.code in plan.entitlements).map((plan) => plan.name),
    })).filter((upgrade) => upgrade.availableOn.length > 0),
    availablePlans: (input.offeredPlans ?? []).filter((plan) => plan.state === "active").map((plan) => ({
      key: plan.plan,
      name: plan.name,
      version: planVersionRef(plan),
      current: input.planVersion?.plan === plan.plan && Boolean(input.subscription),
      capabilities: Object.keys(plan.entitlements).map(nameOf),
    })),
  };
}

/** "18 of 25 team seats used · Included with Pro" style contextual copy. */
export function describeLimit(document: TenantCapabilityDocument, code: string, used: number, noun: string): string | undefined {
  const capability = document.capabilities.find((entry) => entry.code === code && entry.enabled);
  if (!capability) return undefined;
  const maximum = capability.values.maximum;
  const amount = typeof maximum === "number" ? `${used} of ${maximum} ${noun} used` : `${used} ${noun} used`;
  return capability.includedWith ? `${amount}\nIncluded with ${capability.includedWith}` : `${amount}\nIncluded by contract`;
}
