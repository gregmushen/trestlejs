import type { EffectiveEntitlement, SubscriptionOverride } from "./effective.js";
import type { FeatureCatalog, PrivilegeValue } from "./features.js";

/**
 * The operator's entitlement explorer (docs/ADMIN_REQUIRED_CHANGES.md §4.3):
 * every catalog feature, whether or not the organization has it, with the
 * provenance of each effective value. Pure; it never reads or writes state.
 */

export type ValueProvenance = Readonly<{ name: string; value: PrivilegeValue; source: "plan" | "override"; ref: string | null }>;

export type FeatureExplanation = Readonly<{
  code: string;
  name: string;
  description: string;
  metered: boolean;
  /** included: from the plan; overridden: an override changed it; removed: an override turned it off; unavailable: not on the plan. */
  status: "included" | "overridden" | "removed" | "unavailable";
  values: Readonly<Record<string, PrivilegeValue>>;
  provenance: readonly ValueProvenance[];
  /** Privileges the feature defines that no source sets. */
  unset: readonly string[];
  overrideId?: string;
  effectiveAt?: string;
  expiresAt?: string;
}>;

export function explainEntitlements(catalog: FeatureCatalog, effective: readonly EffectiveEntitlement[], overrides: readonly SubscriptionOverride[]): FeatureExplanation[] {
  return catalog.list().map((feature) => {
    const entry = effective.find((candidate) => candidate.code === feature.code);
    const base = { code: feature.code, name: feature.name, description: feature.description, metered: Boolean(feature.metered) };
    if (!entry) return { ...base, status: "unavailable" as const, values: {}, provenance: [], unset: Object.keys(feature.privileges) };
    const override = entry.overrideId ? overrides.find((candidate) => candidate.id === entry.overrideId) : undefined;
    const provenance = Object.entries(entry.values).map(([name, value]): ValueProvenance => override && name in override.values
      ? { name, value, source: "override", ref: override.id }
      : { name, value, source: "plan", ref: entry.inheritedFrom ?? null });
    const status = entry.source === "subscription_override" ? entry.enabled ? "overridden" as const : "removed" as const : "included" as const;
    return {
      ...base, status, values: entry.values, provenance, unset: Object.keys(feature.privileges).filter((name) => !(name in entry.values)),
      ...(entry.overrideId ? { overrideId: entry.overrideId } : {}), effectiveAt: entry.effectiveAt, ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
    };
  });
}

export type EntitlementChange = Readonly<{
  code: string;
  name: string;
  change: "added" | "removed" | "changed" | "unchanged";
  before: Readonly<{ enabled: boolean; values: Readonly<Record<string, PrivilegeValue>> }> | null;
  after: Readonly<{ enabled: boolean; values: Readonly<Record<string, PrivilegeValue>> }> | null;
  /** Privilege-level differences for changed features. */
  differences: ReadonlyArray<Readonly<{ name: string; before: PrivilegeValue | undefined; after: PrivilegeValue | undefined }>>;
}>;

/** What a proposed plan or override would change, feature by feature, across the whole catalog. */
export function compareEntitlements(catalog: FeatureCatalog, before: readonly EffectiveEntitlement[], after: readonly EffectiveEntitlement[]): EntitlementChange[] {
  const state = (entry: EffectiveEntitlement | undefined) => entry && entry.enabled ? { enabled: true, values: entry.values } : null;
  return catalog.list().map((feature) => {
    const was = state(before.find((entry) => entry.code === feature.code));
    const will = state(after.find((entry) => entry.code === feature.code));
    const names = [...new Set([...Object.keys(was?.values ?? {}), ...Object.keys(will?.values ?? {})])].sort();
    const differences = was && will ? names.filter((name) => was.values[name] !== will.values[name]).map((name) => ({ name, before: was.values[name], after: will.values[name] })) : [];
    const change = !was && !will ? "unchanged" as const : !was ? "added" as const : !will ? "removed" as const : differences.length ? "changed" as const : "unchanged" as const;
    return { code: feature.code, name: feature.name, change, before: was, after: will, differences };
  });
}
