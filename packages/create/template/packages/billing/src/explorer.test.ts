import { describe, expect, it } from "vitest";

import { activePlanVersion, compareEntitlements, defaultPlanVersions, explainEntitlements, features, resolveEffectiveEntitlements, type SubscriptionOverride } from "./index.js";

const now = new Date("2026-09-22T17:00:00Z");
const starter = activePlanVersion(defaultPlanVersions, "starter")!;
const pro = activePlanVersion(defaultPlanVersions, "pro")!;
const override: SubscriptionOverride = { id: "ovr-1", organizationId: "org-a", code: "team.members", enabled: true, values: { maximum: 40 }, reason: "Contract", author: "op-1", effectiveAt: new Date("2026-09-01T00:00:00Z") };

describe("entitlement explorer", () => {
  it("lists the whole catalog, marking unavailable features and the source of each value", () => {
    const effective = resolveEffectiveEntitlements(features, { status: "active", planVersion: pro }, [override], now);
    const rows = explainEntitlements(features, effective, [override]);
    expect(rows.map((row) => row.code)).toEqual(features.list().map((feature) => feature.code));
    const members = rows.find((row) => row.code === "team.members")!;
    expect(members.status).toBe("overridden");
    expect(members.provenance.find((entry) => entry.name === "maximum")).toEqual({ name: "maximum", value: 40, source: "override", ref: "ovr-1" });
    const missing = rows.filter((row) => !Object.keys(pro.entitlements).includes(row.code) && row.code !== "team.members");
    for (const row of missing) expect(row.status).toBe("unavailable");
    const planned = rows.find((row) => row.status === "included")!;
    expect(planned.provenance.every((entry) => entry.source === "plan" && entry.ref === `pro@${pro.version}`)).toBe(true);
  });

  it("marks a feature removed by a disabling override", () => {
    const code = Object.keys(pro.entitlements)[0]!;
    const disabling = { ...override, id: "ovr-2", code, enabled: false, values: {} };
    const rows = explainEntitlements(features, resolveEffectiveEntitlements(features, { status: "active", planVersion: pro }, [disabling], now), [disabling]);
    expect(rows.find((row) => row.code === code)?.status).toBe("removed");
  });

  it("compares a proposed plan change feature by feature without touching state", () => {
    const before = resolveEffectiveEntitlements(features, { status: "active", planVersion: starter }, [], now);
    const after = resolveEffectiveEntitlements(features, { status: "active", planVersion: pro }, [], now);
    const changes = compareEntitlements(features, before, after);
    expect(changes).toHaveLength(features.list().length);
    const added = Object.keys(pro.entitlements).filter((code) => !(code in starter.entitlements));
    for (const code of added) expect(changes.find((change) => change.code === code)?.change).toBe("added");
    expect(compareEntitlements(features, before, before).every((change) => change.change === "unchanged")).toBe(true);
    const raised = compareEntitlements(features, after, resolveEffectiveEntitlements(features, { status: "active", planVersion: pro }, [override], now)).find((change) => change.code === "team.members")!;
    expect(raised.change).toBe("changed");
    expect(raised.differences).toEqual([{ name: "maximum", before: pro.entitlements["team.members"]?.maximum, after: 40 }]);
  });
});
