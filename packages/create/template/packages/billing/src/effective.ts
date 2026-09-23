import type { BillingStatus } from "@__TRESTLE_PROJECT_NAME__/integrations";

import { validateEntitlementValues, type FeatureCatalog, type PrivilegeValue } from "./features.js";
import { planVersionRef, type EntitlementValues, type PlanVersion } from "./plans.js";

export type SubscriptionOverride = Readonly<{
  id: string;
  organizationId: string;
  code: string;
  /** False removes a plan entitlement for this subscription only. */
  enabled: boolean;
  values: EntitlementValues;
  reason: string;
  author: string;
  effectiveAt: Date;
  expiresAt?: Date | null;
  removedAt?: Date | null;
}>;

export type EntitlementSourceKind = "plan" | "subscription_override";

export type EffectiveEntitlement = Readonly<{
  code: string;
  enabled: boolean;
  values: Readonly<Record<string, PrivilegeValue>>;
  source: EntitlementSourceKind;
  inheritedFrom?: string;
  overrideId?: string;
  effectiveAt: string;
  expiresAt?: string;
}>;

export type SubscriptionState = Readonly<{ status: BillingStatus; planVersion: PlanVersion | null; startedAt?: Date }>;

/** Subscription states that grant plan entitlements. Past-due keeps access during dunning. */
export const entitlingStatuses: ReadonlySet<BillingStatus> = new Set(["active", "trialing", "past_due"]);

export class OverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverrideError";
  }
}

export function validateOverride(catalog: FeatureCatalog, override: Omit<SubscriptionOverride, "id">): string[] {
  const problems = validateEntitlementValues(catalog, override.code, override.values);
  if (!override.reason.trim()) problems.push("an override requires a reason");
  if (!override.author.trim()) problems.push("an override requires an author");
  if (override.expiresAt && override.expiresAt <= override.effectiveAt) problems.push("an override must expire after it takes effect");
  if (!override.enabled && Object.keys(override.values).length > 0) problems.push("a disabling override cannot carry values");
  return problems;
}

export function overrideActive(override: SubscriptionOverride, now: Date): boolean {
  return !override.removedAt && override.effectiveAt <= now && (!override.expiresAt || override.expiresAt > now);
}

/**
 * Resolves the local effective-entitlement projection from the recorded plan
 * version and this subscription's overrides. Provider state never participates.
 */
export function resolveEffectiveEntitlements(catalog: FeatureCatalog, subscription: SubscriptionState | null, overrides: readonly SubscriptionOverride[], now: Date): EffectiveEntitlement[] {
  if (!subscription?.planVersion || !entitlingStatuses.has(subscription.status)) return [];
  const version = subscription.planVersion;
  const inheritedFrom = planVersionRef(version);
  const since = new Date(Math.max(version.activatedAt?.getTime() ?? 0, subscription.startedAt?.getTime() ?? 0));
  const result = new Map<string, EffectiveEntitlement>();
  for (const [code, values] of Object.entries(version.entitlements)) {
    if (!catalog.has(code)) continue;
    result.set(code, { code, enabled: true, values, source: "plan", inheritedFrom, effectiveAt: since.toISOString() });
  }
  const active = overrides.filter((override) => overrideActive(override, now) && catalog.has(override.code)).sort((a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime() || a.id.localeCompare(b.id));
  for (const override of active) {
    const base = result.get(override.code);
    result.set(override.code, {
      code: override.code,
      enabled: override.enabled,
      values: override.enabled ? { ...(base?.values ?? {}), ...override.values } : {},
      source: "subscription_override",
      ...(base?.inheritedFrom ? { inheritedFrom: base.inheritedFrom } : {}),
      overrideId: override.id,
      effectiveAt: override.effectiveAt.toISOString(),
      ...(override.expiresAt ? { expiresAt: override.expiresAt.toISOString() } : {}),
    });
  }
  return [...result.values()].sort((a, b) => a.code.localeCompare(b.code));
}
