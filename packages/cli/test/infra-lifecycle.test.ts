import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { SUPPORTED_TOOLCHAIN, type CapabilityRow, type InfraOperation } from "../src/infra/capabilities.js";
import { capabilityFor } from "../src/infra/capability-matrix.js";
import { planAdopt, planDestroy, planDetach, planTierChange, type DestroyEvidence } from "../src/infra/lifecycle.js";
import { parseBindings, parseIntent, type Observation } from "../src/infra/schema.js";

const now = new Date("2026-10-02T00:00:00.000Z");
const hosted = (provider: string, service: string, operation: InfraOperation): CapabilityRow | undefined => {
  const row = capabilityFor(provider, service, operation);
  return row ? { ...row, evidence: row.evidence === "unsupported" ? "unsupported" : "hosted_verified", unknowns: [], observedAt: now.toISOString() } : undefined;
};

const intent = (database: Record<string, unknown>) => parseIntent(stringify({ schemaVersion: 1, backend: "stripe-projects", environments: { staging: { projectsBinding: "s", resources: { database: { provider: "neon", service: "postgres", plan: "free", ...database } } } } }));
const bindings = (resources: Record<string, unknown> = { database: { provider: "neon", service: "postgres", plan: "free", externalId: "neon_res0001", lifecycleOwner: "stripe-projects", boundBy: "op-1" } }) => parseBindings(JSON.stringify({ schemaVersion: 1, environments: { staging: { trestleProjectId: "t", stripeAccountId: "acct_fake0000001", projectsProjectId: "proj_1", projectsEnvironment: "staging", generation: 2, resources } } })).environments.staging!;
const observation = (resources: Observation["resources"]): Observation => ({ observedAt: now.toISOString(), stripeAccountId: "acct_fake0000001", projectsProjectId: "proj_1", projectsEnvironment: "staging", resources, complete: true });
const evidence: DestroyEvidence = { consumers: [], referenceScanComplete: true, restoreVerified: true, drained: true };

describe("destruction", () => {
  const deletable = intent({ deletionPolicy: "delete" });
  const live = observation([{ externalId: "neon_res0001", provider: "neon", service: "postgres", name: "database" }]);

  it("plans deletion of the exact bound ID only when every safeguard holds", () => {
    const plan = planDestroy({ intent: deletable, environment: "staging", binding: bindings(), resource: "database", observation: live, evidence, confirmTarget: "neon_res0001", toolchain: SUPPORTED_TOOLCHAIN, now, capabilities: hosted });
    expect(plan).toMatchObject({ kind: "destroy", externalId: "neon_res0001", destructive: true, blockers: [] });
  });

  it("does not delete a replacement that reused the old name (AR-11)", () => {
    const replaced = observation([{ externalId: "neon_res0009", provider: "neon", service: "postgres", name: "database" }]);
    const plan = planDestroy({ intent: deletable, environment: "staging", binding: bindings(), resource: "database", observation: replaced, evidence, confirmTarget: "neon_res0001", toolchain: SUPPORTED_TOOLCHAIN, now, capabilities: hosted });
    expect(plan.blockers.join(" ")).toMatch(/no longer exists/u);
    expect(plan.blockers.join(" ")).toMatch(/now resolves to neon_res0009, a replacement/u);
    expect(plan.externalId).toBe("neon_res0001");
  });

  it("blocks on retain policy, name-only confirmation, unknown consumers, missing restore proof, undrained work and incomplete discovery", () => {
    const cases: Array<[Parameters<typeof planDestroy>[0], RegExp]> = [
      [{ intent: intent({}), environment: "staging", binding: bindings(), resource: "database", observation: live, evidence, confirmTarget: "neon_res0001", now, capabilities: hosted, toolchain: SUPPORTED_TOOLCHAIN }, /deletionPolicy retain/u],
      [{ intent: deletable, environment: "staging", binding: bindings(), resource: "database", observation: live, evidence, confirmTarget: "database", now, capabilities: hosted, toolchain: SUPPORTED_TOOLCHAIN }, /confirm the exact target ID/u],
      [{ intent: deletable, environment: "staging", binding: bindings(), resource: "database", observation: live, evidence: { ...evidence, consumers: ["worker"] }, confirmTarget: "neon_res0001", now, capabilities: hosted, toolchain: SUPPORTED_TOOLCHAIN }, /still referenced by: worker/u],
      [{ intent: deletable, environment: "staging", binding: bindings(), resource: "database", observation: live, evidence: { ...evidence, referenceScanComplete: false }, confirmTarget: "neon_res0001", now, capabilities: hosted, toolchain: SUPPORTED_TOOLCHAIN }, /reference discovery is incomplete/u],
      [{ intent: deletable, environment: "staging", binding: bindings(), resource: "database", observation: live, evidence: { ...evidence, restoreVerified: false }, confirmTarget: "neon_res0001", now, capabilities: hosted, toolchain: SUPPORTED_TOOLCHAIN }, /backup-exists flag is not restore evidence/u],
      [{ intent: deletable, environment: "staging", binding: bindings(), resource: "database", observation: live, evidence: { ...evidence, drained: false }, confirmTarget: "neon_res0001", now, capabilities: hosted, toolchain: SUPPORTED_TOOLCHAIN }, /not been drained/u],
      [{ intent: deletable, environment: "staging", binding: bindings(), resource: "database", evidence, confirmTarget: "neon_res0001", now, capabilities: hosted, toolchain: SUPPORTED_TOOLCHAIN }, /no fresh observation/u],
    ];
    for (const [input, reason] of cases) expect(planDestroy(input).blockers.join(" "), String(reason)).toMatch(reason);
  });

  it("stays blocked with the recorded capability evidence, because remove cannot target an exact ID", () => {
    const plan = planDestroy({ intent: deletable, environment: "staging", binding: bindings(), resource: "database", observation: live, evidence, confirmTarget: "neon_res0001", toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(plan.blockers.join(" ")).toMatch(/exact immutable-ID targeting/u);
  });

  it("refuses to plan deletion of an unbound resource", () => {
    expect(() => planDestroy({ intent: deletable, environment: "staging", binding: bindings({}), resource: "database", evidence, confirmTarget: null, now })).toThrow(/no exact identity/u);
  });
});

describe("detach and adoption", () => {
  it("keeps detach blocked instead of falling back to a deleting command", () => {
    const plan = planDetach({ intent: intent({}), environment: "staging", binding: bindings(), resource: "database", toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(plan).toMatchObject({ kind: "detach", destructive: false });
    expect(plan.blockers.join(" ")).toMatch(/non-destructive detach/u);
  });

  it("adopts only an exact ID verified in the bound account, once, with the previous writer named", () => {
    const adoptIntent = intent({ disposition: "adopt", externalId: "neon_existing1" });
    const seen = observation([{ externalId: "neon_existing1", provider: "neon", service: "postgres", name: "legacy-db" }]);
    const unsupported = planAdopt({ intent: adoptIntent, environment: "staging", binding: bindings({}), resource: "database", observation: seen, previousWriter: "scripts/neon-preview.mjs", toolchain: SUPPORTED_TOOLCHAIN, now, capabilities: hosted });
    expect(unsupported.blockers.join(" ")).toMatch(/unsupported through Projects/u);
    const supported = (provider: string, service: string, operation: InfraOperation) => ({ ...hosted(provider, service, operation)!, evidence: "hosted_verified" as const });
    expect(planAdopt({ intent: adoptIntent, environment: "staging", binding: bindings({}), resource: "database", observation: seen, previousWriter: "scripts/neon-preview.mjs", toolchain: SUPPORTED_TOOLCHAIN, now, capabilities: supported }).blockers).toEqual([]);
    expect(planAdopt({ intent: adoptIntent, environment: "staging", binding: bindings({}), resource: "database", observation: observation([{ externalId: "neon_other", provider: "neon", service: "postgres", name: "neon_existing1" }]), previousWriter: "x", toolchain: SUPPORTED_TOOLCHAIN, now, capabilities: supported }).blockers.join(" ")).toMatch(/not found in the bound account/u);
    expect(planAdopt({ intent: adoptIntent, environment: "staging", binding: bindings({ other: { provider: "neon", service: "postgres", externalId: "neon_existing1", lifecycleOwner: "direct", boundBy: "op" } }), resource: "database", observation: seen, previousWriter: "x", toolchain: SUPPORTED_TOOLCHAIN, now, capabilities: supported }).blockers.join(" ")).toMatch(/adopted twice/u);
    expect(planAdopt({ intent: adoptIntent, environment: "staging", binding: bindings({}), resource: "database", observation: seen, previousWriter: null, toolchain: SUPPORTED_TOOLCHAIN, now, capabilities: supported }).blockers.join(" ")).toMatch(/previous writer/u);
  });
});

describe("tier changes", () => {
  it("requires a fresh price within the declared limit and labels downgrades destructive", () => {
    const limited = intent({ costLimit: { currency: "usd", monthlyMinor: 2000 } });
    const base = { intent: limited, environment: "staging" as const, binding: bindings(), resource: "database", targetPlan: "launch", currentPlan: "free", toolchain: SUPPORTED_TOOLCHAIN, now, capabilities: hosted };
    expect(planTierChange({ ...base, price: { currency: "usd", monthlyMinor: 1900, accountWide: false }, direction: "upgrade" }).blockers).toEqual([]);
    expect(planTierChange({ ...base, price: { currency: "usd", monthlyMinor: 2500, accountWide: false }, direction: "upgrade" }).blockers.join(" ")).toMatch(/exceeds the declared cost limit/u);
    expect(planTierChange({ ...base, price: null, direction: "upgrade" }).blockers.join(" ")).toMatch(/price is unknown/u);
    expect(planTierChange({ ...base, price: { currency: "usd", monthlyMinor: 0, accountWide: true }, direction: "upgrade" }).blockers.join(" ")).toMatch(/account-wide/u);
    expect(planTierChange({ ...base, intent: intent({}), price: { currency: "usd", monthlyMinor: 1900, accountWide: false }, direction: "upgrade" }).blockers.join(" ")).toMatch(/declared costLimit/u);
    expect(planTierChange({ ...base, price: { currency: "usd", monthlyMinor: 0, accountWide: false }, direction: "downgrade", targetPlan: "free", currentPlan: "launch" })).toMatchObject({ destructive: true });
    expect(planTierChange({ ...base, price: { currency: "usd", monthlyMinor: 1900, accountWide: false }, direction: "upgrade" }).safeguards[0]).toBe("change neon/free → neon/launch");
  });
});
