// The side-effect-free plans module: the SPA must never bundle the billing repository.
import { featureDefinitions, type FeatureCode } from "@__TRESTLE_PROJECT_NAME__/billing/plans";

/**
 * The admin's view of the application's commercial model. The billing package
 * defines features as codes with privilege names; the admin works with them
 * through this small catalog so views and the registry share one definition.
 */
export type PrivilegeValue = string | number | boolean;
export type FeatureCatalog = Readonly<{ has(code: string): boolean; list(): readonly Feature[] }>;
export type Feature = Readonly<{ code: string; name: string; description: string; privileges: readonly string[]; metered?: boolean }>;

export const features: FeatureCatalog = {
  has: (code) => Object.hasOwn(featureDefinitions, code),
  list: () => (Object.keys(featureDefinitions) as FeatureCode[]).map((code) => ({ code, name: code, description: featureDefinitions[code].description, privileges: featureDefinitions[code].privileges })),
};

/** An entitlement decision as the admin API reports it. */
export type EffectiveEntitlement = { code: string; enabled: boolean; source: "plan" | "override" | "default"; inheritedFrom?: string; effectiveAt: string | Date };
export type PlanVersionState = "draft" | "active" | "grandfathered" | "retired";
export type PlanVersion = { plan: string; version: number; name: string; state: PlanVersionState; entitlements: Array<{ code: string; enabled: boolean; values: Record<string, PrivilegeValue> }> };
export type QuotaState = { code: string; used: number; limit: number | null; resetsAt: string | null };
export type ReconciliationResult = { outcome: "in_sync" | "repaired" | "drift"; differences: Array<{ field: string; local: string | null; provider: string | null }> };
