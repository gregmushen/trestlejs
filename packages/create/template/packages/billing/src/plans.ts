import { features, type FeatureCode } from "./catalog.js";
import { validateEntitlementValues, type FeatureCatalog, type PrivilegeValue } from "./features.js";

export type PlanVersionState = "draft" | "active" | "grandfathered" | "retired";
export type EntitlementValues = Readonly<Record<string, PrivilegeValue>>;

export type PlanVersion = Readonly<{
  plan: string;
  version: number;
  name: string;
  state: PlanVersionState;
  /** Feature code → typed privilege values. Presence enables the feature. */
  entitlements: Readonly<Record<string, EntitlementValues>>;
  activatedAt?: Date;
  grandfatheredAt?: Date;
  retiredAt?: Date;
}>;

const planKeyPattern = /^[a-z][a-z0-9_-]{0,39}$/u;
const transitions: Readonly<Record<PlanVersionState, readonly PlanVersionState[]>> = {
  draft: ["active"],
  active: ["grandfathered"],
  grandfathered: ["retired"],
  retired: [],
};

export class PlanVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanVersionError";
  }
}

export const planVersionRef = (version: Pick<PlanVersion, "plan" | "version">): string => `${version.plan}@${version.version}`;

export function parsePlanVersionRef(value: string): { plan: string; version: number } | null {
  const match = /^([a-z][a-z0-9_-]{0,39})@([1-9]\d{0,5})$/u.exec(value);
  return match ? { plan: match[1]!, version: Number(match[2]) } : null;
}

export function validatePlanVersion(catalog: FeatureCatalog, version: PlanVersion): string[] {
  const problems: string[] = [];
  if (!planKeyPattern.test(version.plan)) problems.push(`plan key ${version.plan} must be lowercase`);
  if (!Number.isSafeInteger(version.version) || version.version < 1) problems.push("version must be a positive integer");
  if (!version.name.trim()) problems.push("plan name is required");
  for (const [code, values] of Object.entries(version.entitlements)) problems.push(...validateEntitlementValues(catalog, code, values));
  return problems;
}

/** Plans are immutable once activated: only drafts accept entitlement edits. */
export function reviseDraft(version: PlanVersion, changes: Partial<Pick<PlanVersion, "name" | "entitlements">>, catalog: FeatureCatalog = features): PlanVersion {
  if (version.state !== "draft") throw new PlanVersionError(`${planVersionRef(version)} is ${version.state}; create a new version instead`);
  const next = { ...version, ...changes };
  const problems = validatePlanVersion(catalog, next);
  if (problems.length) throw new PlanVersionError(problems.join("; "));
  return next;
}

export function transitionPlanVersion(version: PlanVersion, to: PlanVersionState, now: Date, catalog: FeatureCatalog = features): PlanVersion {
  if (!transitions[version.state].includes(to)) throw new PlanVersionError(`${planVersionRef(version)} cannot move from ${version.state} to ${to}`);
  if (to === "active") {
    const problems = validatePlanVersion(catalog, version);
    if (problems.length) throw new PlanVersionError(problems.join("; "));
    return { ...version, state: to, activatedAt: now };
  }
  return to === "grandfathered" ? { ...version, state: to, grandfatheredAt: now } : { ...version, state: to, retiredAt: now };
}

/** Editing an active plan starts a new draft version copied from the latest. */
export function draftNextVersion(versions: readonly PlanVersion[], plan: string): PlanVersion {
  const existing = versions.filter((version) => version.plan === plan).sort((a, b) => b.version - a.version);
  const latest = existing[0];
  if (!latest) throw new PlanVersionError(`plan ${plan} has no versions`);
  if (latest.state === "draft") throw new PlanVersionError(`${planVersionRef(latest)} is already a draft`);
  return { plan, version: latest.version + 1, name: latest.name, state: "draft", entitlements: latest.entitlements };
}

export function definePlanCatalog(catalog: FeatureCatalog, versions: readonly PlanVersion[]): readonly PlanVersion[] {
  const seen = new Set<string>();
  for (const version of versions) {
    const ref = planVersionRef(version);
    if (seen.has(ref)) throw new PlanVersionError(`${ref} is defined twice`);
    seen.add(ref);
    const problems = validatePlanVersion(catalog, version);
    if (problems.length) throw new PlanVersionError(`${ref}: ${problems.join("; ")}`);
  }
  for (const plan of new Set(versions.map((version) => version.plan))) {
    if (versions.filter((version) => version.plan === plan && version.state === "active").length > 1) throw new PlanVersionError(`plan ${plan} has more than one active version`);
  }
  return versions;
}

const activatedAt = new Date("2026-01-01T00:00:00Z");

/** Source-defined initial catalog; runtime plan versions are managed in admin. */
export const defaultPlanVersions = definePlanCatalog(features, [
  {
    plan: "starter", version: 1, name: "Starter", state: "active", activatedAt,
    entitlements: { "workspace.single": {}, "article.basic": {}, "team.members": { maximum: 3 } },
  },
  {
    plan: "pro", version: 1, name: "Pro", state: "active", activatedAt,
    entitlements: {
      "workspace.single": {}, "article.basic": {}, "team.members": { maximum: 25 }, "workflows.advanced": {},
      "api.access": { maxKeys: 5 }, "api.requests": { included: 100_000, limit: 250_000, enforcement: "hard", overage: "block" },
    },
  },
  {
    plan: "business", version: 1, name: "Business", state: "active", activatedAt,
    entitlements: {
      "workspace.single": {}, "article.basic": {}, "team.members": { maximum: null }, "workflows.advanced": {},
      "roles.custom": {}, "api.access": { maxKeys: 50 }, "api.requests": { included: 1_000_000, limit: null, enforcement: "soft", overage: "bill" },
      "support.priority": { responseTime: "PT4H" },
    },
  },
]);

export function activePlanVersion(versions: readonly PlanVersion[], plan: string): PlanVersion | undefined {
  return versions.find((version) => version.plan === plan && version.state === "active");
}

const entitlementsOf = (plan: string): readonly FeatureCode[] => Object.keys(activePlanVersion(defaultPlanVersions, plan)?.entitlements ?? {}) as FeatureCode[];
export const plans = {
  starter: { entitlements: entitlementsOf("starter") },
  pro: { entitlements: entitlementsOf("pro") },
  business: { entitlements: entitlementsOf("business") },
} as const;
export type PlanName = keyof typeof plans;
export type Entitlement = FeatureCode;
export const planEntitlements: Record<PlanName, readonly Entitlement[]> = { starter: plans.starter.entitlements, pro: plans.pro.entitlements, business: plans.business.entitlements };
