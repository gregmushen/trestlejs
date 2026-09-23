import { describe, expect, it } from "vitest";

import {
  activePlanVersion,
  defaultPlanVersions,
  defineFeatures,
  describeLimit,
  draftNextVersion,
  Entitlements,
  EntitlementRequiredError,
  evaluateQuota,
  features,
  periodBounds,
  PlanVersionError,
  reconcileSubscription,
  resolveEffectiveEntitlements,
  reviseDraft,
  tenantCapabilityDocument,
  transitionPlanVersion,
  validateEntitlementValues,
  validateOverride,
  type SubscriptionOverride,
} from "./index.js";

const now = new Date("2026-09-22T17:00:00Z");
const pro = activePlanVersion(defaultPlanVersions, "pro")!;
const override = (values: Partial<SubscriptionOverride> = {}): SubscriptionOverride => ({
  id: "ovr-1", organizationId: "org-a", code: "team.members", enabled: true, values: { maximum: 40 },
  reason: "Negotiated contract", author: "op-1", effectiveAt: new Date("2026-09-01T00:00:00Z"), ...values,
});

describe("features and typed privileges", () => {
  it("validates privilege shapes and values", () => {
    expect(() => defineFeatures({ "a.b": { name: "x", description: "x", privileges: { level: { type: "select" } } } })).toThrow("requires options");
    expect(() => defineFeatures({ "a.b": { name: "x", description: "x", metered: { unit: "call", period: "month" }, privileges: { limit: { type: "integer" } } } })).toThrow("reserves");
    expect(validateEntitlementValues(features, "team.members", { maximum: 0 })).toEqual(["team.members.maximum must be an integer >= 1"]);
    expect(validateEntitlementValues(features, "support.priority", { responseTime: "four hours" })).toEqual(["support.priority.responseTime must be an ISO 8601 duration such as P30D"]);
    expect(validateEntitlementValues(features, "api.requests", { included: 10, limit: 5, enforcement: "hard", overage: "block" })).toEqual(["api.requests.limit must be at least the included usage"]);
    expect(validateEntitlementValues(features, "api.requests", { enforcement: "maybe" })).toEqual(["api.requests.enforcement must be one of hard, soft"]);
    expect(validateEntitlementValues(features, "made.up", {})).toEqual(["made.up is not a defined feature"]);
  });
});

describe("versioned plans", () => {
  it("are immutable once activated and move draft → active → grandfathered → retired", () => {
    expect(() => reviseDraft(pro, { name: "Pro+" })).toThrow(PlanVersionError);
    const draft = draftNextVersion(defaultPlanVersions, "pro");
    expect(draft).toMatchObject({ plan: "pro", version: 2, state: "draft" });
    const revised = reviseDraft(draft, { entitlements: { ...draft.entitlements, "team.members": { maximum: 30 } } });
    expect(() => reviseDraft(draft, { entitlements: { "team.members": { maximum: "lots" } } })).toThrow("must be an integer");
    const active = transitionPlanVersion(revised, "active", now);
    expect(active.activatedAt).toEqual(now);
    expect(pro.entitlements["team.members"]).toEqual({ maximum: 25 });
    expect(() => transitionPlanVersion(active, "retired", now)).toThrow("cannot move from active to retired");
    expect(transitionPlanVersion(transitionPlanVersion(pro, "grandfathered", now), "retired", now).state).toBe("retired");
  });
});

describe("effective entitlements", () => {
  it("records plan provenance and applies audited subscription overrides", () => {
    const effective = resolveEffectiveEntitlements(features, { status: "active", planVersion: pro }, [override()], now);
    expect(effective.find((entry) => entry.code === "team.members")).toEqual({
      code: "team.members", enabled: true, values: { maximum: 40 }, source: "subscription_override",
      inheritedFrom: "pro@1", overrideId: "ovr-1", effectiveAt: "2026-09-01T00:00:00.000Z",
    });
    expect(effective.find((entry) => entry.code === "workflows.advanced")).toMatchObject({ source: "plan", inheritedFrom: "pro@1" });
    expect(pro.entitlements["team.members"]).toEqual({ maximum: 25 });
  });

  it("ignores expired, future, and removed overrides and supports disabling", () => {
    const effective = resolveEffectiveEntitlements(features, { status: "active", planVersion: pro }, [
      override({ id: "expired", expiresAt: new Date("2026-09-10T00:00:00Z") }),
      override({ id: "future", effectiveAt: new Date("2026-10-01T00:00:00Z") }),
      override({ id: "removed", removedAt: new Date("2026-09-05T00:00:00Z") }),
      override({ id: "off", code: "workflows.advanced", enabled: false, values: {} }),
    ], now);
    expect(effective.find((entry) => entry.code === "team.members")?.values).toEqual({ maximum: 25 });
    const entitlements = new Entitlements(effective);
    expect(entitlements.has("workflows.advanced")).toBe(false);
    expect(() => entitlements.require("workflows.advanced")).toThrow(EntitlementRequiredError);
    expect(entitlements.value("team.members", "maximum")).toBe(25);
  });

  it("grants nothing to unsubscribed, cancelled, or incomplete tenants, even with overrides", () => {
    expect(resolveEffectiveEntitlements(features, null, [override()], now)).toEqual([]);
    expect(resolveEffectiveEntitlements(features, { status: "cancelled", planVersion: pro }, [override()], now)).toEqual([]);
    expect(resolveEffectiveEntitlements(features, { status: "incomplete", planVersion: pro }, [], now)).toEqual([]);
    expect(resolveEffectiveEntitlements(features, { status: "past_due", planVersion: pro }, [], now).length).toBeGreaterThan(0);
  });

  it("requires a reason, author, and coherent window for overrides", () => {
    expect(validateOverride(features, { ...override(), reason: " ", author: "", expiresAt: new Date("2026-08-01T00:00:00Z") })).toEqual([
      "an override requires a reason", "an override requires an author", "an override must expire after it takes effect",
    ]);
  });
});

describe("quotas", () => {
  const period = periodBounds("month", now);
  const requests = (values: Record<string, unknown>) => ({ code: "api.requests", enabled: true, values: values as never, source: "plan" as const, effectiveAt: now.toISOString() });

  it("uses UTC calendar periods", () => {
    expect(period).toEqual({ start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z") });
  });

  it("enforces hard limits and reports soft overage", () => {
    expect(evaluateQuota(requests({ included: 10, limit: 12, enforcement: "hard", overage: "allow" }), 11, period)).toMatchObject({ allowed: true, overageUnits: 1, exceeded: false });
    expect(evaluateQuota(requests({ included: 10, limit: 12, enforcement: "hard", overage: "allow" }), 12, period)).toMatchObject({ allowed: false, exceeded: true });
    expect(evaluateQuota(requests({ included: 10, limit: 12, enforcement: "soft", overage: "bill" }), 20, period)).toMatchObject({ allowed: true, exceeded: true });
    expect(evaluateQuota(requests({ included: 10, limit: null, enforcement: "hard", overage: "block" }), 10, period).allowed).toBe(false);
    expect(evaluateQuota(undefined, 0, period).allowed).toBe(false);
  });
});

describe("customer transparency", () => {
  it("exposes safe plan truth without provider identifiers or override reasons", () => {
    const effective = resolveEffectiveEntitlements(features, { status: "active", planVersion: pro }, [override()], now);
    const document = tenantCapabilityDocument({
      catalog: features,
      subscription: { organizationId: "org-a", provider: "stripe", providerCustomerId: "cus_secret", providerSubscriptionId: "sub_secret", plan: "pro", status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: new Date("2026-10-01T00:00:00Z"), entitlements: [] },
      planVersion: pro,
      effective,
      quotas: [evaluateQuota(effective.find((entry) => entry.code === "api.requests"), 42, periodBounds("month", now), 0)],
      scheduledChanges: [{ id: "c1", organizationId: "org-a", toPlanVersion: "business@1", effectiveAt: new Date("2026-10-01T00:00:00Z") }],
      offeredPlans: defaultPlanVersions,
    });
    const serialized = JSON.stringify(document);
    expect(serialized).not.toMatch(/cus_secret|sub_secret|Negotiated contract|op-1|stripe/u);
    expect(document.plan).toMatchObject({ name: "Pro", version: "pro@1", renewsAt: "2026-10-01T00:00:00.000Z" });
    expect(document.contractualOverrides).toEqual([{ code: "team.members", name: "Team members", effectiveAt: "2026-09-01T00:00:00.000Z" }]);
    expect(document.upgrades.find((upgrade) => upgrade.code === "roles.custom")?.availableOn).toEqual(["Business"]);
    expect(document.limits[0]).toMatchObject({ code: "api.requests", used: 42, included: 100_000 });
    expect(describeLimit(document, "workflows.advanced", 0, "flows")).toBe("0 flows used\nIncluded with Pro");
    const base = tenantCapabilityDocument({ catalog: features, subscription: null, planVersion: pro, effective: resolveEffectiveEntitlements(features, { status: "active", planVersion: pro }, [], now) });
    expect(describeLimit(base, "team.members", 18, "team seats")).toBe("18 of 25 team seats used\nIncluded with Pro");
  });
});

describe("reconciliation", () => {
  it("reports drift and a provider-derived repair without applying it", () => {
    const local = { organizationId: "org-a", provider: "stripe", plan: "pro", status: "active" as const, cancelAtPeriodEnd: false, entitlements: ["workflows.advanced"] };
    expect(reconcileSubscription("org-a", local, { organizationId: "org-a", provider: "stripe", plan: "pro", status: "active", cancelAtPeriodEnd: false }).outcome).toBe("in_sync");
    const drift = reconcileSubscription("org-a", local, { organizationId: "org-a", provider: "stripe", plan: "pro", status: "past_due", cancelAtPeriodEnd: true });
    expect(drift.outcome).toBe("drift");
    expect(drift.differences.map(({ field }) => field)).toEqual(["status", "cancelAtPeriodEnd"]);
    expect(drift.repair).toMatchObject({ status: "past_due" });
    expect(reconcileSubscription("org-a", local, null).outcome).toBe("missing_provider");
  });
});
