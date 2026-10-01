import { capabilityFor } from "../src/infra/capability-matrix.js";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { SUPPORTED_TOOLCHAIN } from "../src/infra/capabilities.js";
import { canonicalDigest, canonicalJson } from "../src/infra/canonical.js";
import { dependencyOrder, InfraPlanError, planInfrastructure, planIsExecutable, verifyPlanDigest } from "../src/infra/planner.js";
import { parseBindings, parseIntent, type InfrastructureBindings, type Observation } from "../src/infra/schema.js";
import { parseSetupPlan } from "../src/setup-plan.js";

const now = new Date("2026-10-02T00:00:00.000Z");

const intentDocument = {
  schemaVersion: 1,
  backend: "stripe-projects",
  environments: {
    staging: {
      projectsBinding: "staging-infra",
      resources: {
        database: {
          provider: "neon", service: "postgres", plan: "free",
          credentialBindings: { bootstrap: { output: "DATABASE_URL", classification: "operator-only" } },
        },
        email: { provider: "resend", service: "email", dependsOn: ["database"] },
      },
    },
  },
};

const intent = parseIntent(stringify(intentDocument));

const binding = (resources: InfrastructureBindings["environments"]["staging"] extends infer B ? B extends { resources: infer R } ? R : never : never = {}): InfrastructureBindings => parseBindings(JSON.stringify({
  schemaVersion: 1,
  environments: { staging: { trestleProjectId: "trestle-proj-1", stripeAccountId: "acct_1234567890", projectsProjectId: "proj_abc", projectsEnvironment: "staging", generation: 3, resources } },
}));

const observation = (overrides: Partial<Observation> = {}): Observation => ({
  observedAt: "2026-10-01T23:59:00.000Z", stripeAccountId: "acct_1234567890", projectsProjectId: "proj_abc", projectsEnvironment: "staging", resources: [], complete: true, ...overrides,
});

describe("infrastructure intent schema", () => {
  it("rejects secret values anywhere in intent, independent of key names", () => {
    const leaked = structuredClone(intentDocument) as typeof intentDocument & { environments: { staging: { resources: { database: Record<string, unknown> } } } };
    (leaked.environments.staging.resources.database as Record<string, unknown>).plan = "postgres://owner:pw@ep-x.neon.tech/db";
    expect(() => parseIntent(stringify(leaked))).toThrow(/must not contain secret values/u);
    expect(() => parseIntent(stringify({ ...intentDocument, note: "sk_live_ABCDEFGH12345678" }))).toThrow();
  });

  it("rejects local remote infrastructure, unknown fields, duplicate keys and name-only adoption", () => {
    expect(() => parseIntent(stringify({ ...intentDocument, environments: { local: { projectsBinding: "x", resources: {} } } }))).toThrow(/local development never uses remote infrastructure/u);
    expect(() => parseIntent(stringify({ ...intentDocument, approved: true }))).toThrow(/invalid/u);
    expect(() => parseIntent("schemaVersion: 1\nschemaVersion: 1\n")).toThrow(/not valid YAML/u);
    let message = "";
    try { parseIntent("schemaVersion: 1\nbad: [sk_live_ABCDEFGH12345678 postgres://owner:hunter2@h/db\n  - : :\n"); } catch (error) { message = String(error); }
    expect(message).toMatch(/not valid YAML \(line \d+, column \d+\)/u);
    expect(message).not.toMatch(/sk_live_|hunter2/u);
    const adopt = structuredClone(intentDocument) as unknown as { environments: { staging: { resources: Record<string, Record<string, unknown>> } } };
    adopt.environments.staging.resources.database!.disposition = "adopt";
    expect(() => parseIntent(stringify(adopt))).toThrow(/adoption requires an exact externalId/u);
  });

  it("keeps operator-only credentials out of application consumers and rejects output collisions", () => {
    const deploy = structuredClone(intentDocument) as unknown as { environments: { staging: { resources: Record<string, { credentialBindings: Record<string, unknown> }> } } };
    deploy.environments.staging.resources.database!.credentialBindings.bootstrap = { output: "DATABASE_URL", classification: "operator-only", consumers: ["worker"] };
    expect(() => parseIntent(stringify(deploy))).toThrow(/operator-only credentials cannot be deployed/u);
    deploy.environments.staging.resources.database!.credentialBindings = { a: { output: "A", classification: "operator-only" }, b: { output: "B", as: "A", classification: "operator-only" } };
    expect(() => parseIntent(stringify(deploy))).toThrow(/same name/u);
  });

  it("leaves SetupPlan v1 rejection of external and destructive operations unchanged", () => {
    const base = { schemaVersion: 1, minimumTrestleVersion: "0.1.0", project: { name: "x" }, apps: { site: true, app: true, worker: true }, tenancy: { model: "organization", enforcement: "postgres-rls" }, database: { engine: "postgresql", provider: "neon" }, capabilities: { r2: false, queues: false, workflows: false, durableObjects: false, admin: false }, integrations: { email: false, billing: false }, environments: ["local"] };
    expect(() => parseSetupPlan(JSON.stringify(base))).not.toThrow();
    const issues = (extra: object) => { try { parseSetupPlan(JSON.stringify({ ...base, ...extra })); return ""; } catch (error) { return JSON.stringify((error as { issues?: unknown }).issues); } };
    expect(issues({ externalResources: [{ provider: "neon" }] })).toMatch(/externalResources are not supported/u);
    expect(issues({ destructiveOperations: [{ delete: "db" }] })).toMatch(/destructiveOperations are not supported/u);
  });
});

describe("canonical serialization", () => {
  it("is independent of key order and formatting, and sensitive to meaning", () => {
    const reordered = parseIntent(`backend: stripe-projects\nenvironments:\n  staging:\n    resources:\n      email: {dependsOn: [database], service: email, provider: resend}\n      database:\n        credentialBindings: {bootstrap: {classification: operator-only, output: DATABASE_URL}}\n        plan: free\n        service: postgres\n        provider: neon\n    projectsBinding: staging-infra\nschemaVersion: 1\n`);
    expect(canonicalJson(reordered)).toBe(canonicalJson(intent));
    expect(canonicalDigest(reordered)).toBe(canonicalDigest(intent));
    const changed = parseIntent(stringify({ ...intentDocument, environments: { staging: { ...intentDocument.environments.staging, resources: { ...intentDocument.environments.staging.resources, database: { ...intentDocument.environments.staging.resources.database, plan: "launch" } } } } }));
    expect(canonicalDigest(changed)).not.toBe(canonicalDigest(intent));
    expect(() => canonicalJson({ value: Number.NaN })).toThrow();
  });
});

describe("dependency ordering", () => {
  it("orders dependencies first with deterministic tie-breaks and rejects cycles and unknown references", () => {
    expect(dependencyOrder({ c: { dependsOn: ["a"] }, b: { dependsOn: [] }, a: { dependsOn: [] } })).toEqual(["a", "b", "c"]);
    expect(() => dependencyOrder({ a: { dependsOn: ["b"] }, b: { dependsOn: ["a"] } })).toThrow(/dependency cycle/u);
    expect(() => dependencyOrder({ a: { dependsOn: ["a"] } })).toThrow(/depends on itself/u);
    expect(() => dependencyOrder({ a: { dependsOn: ["ghost"] } })).toThrow(InfraPlanError);
  });

  it("always places each resource after all of its dependencies for random graphs", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    for (let trial = 0; trial < 200; trial += 1) {
      const names = Array.from({ length: 2 + Math.floor(random() * 8) }, (_, index) => `r${index}`);
      // Edges only point to lower indexes, so the graph is acyclic by construction.
      const graph = Object.fromEntries(names.map((name, index) => [name, { dependsOn: names.slice(0, index).filter(() => random() < 0.3) }]));
      const shuffled = Object.fromEntries(Object.entries(graph).sort(() => random() - 0.5));
      const order = dependencyOrder(shuffled);
      expect(order).toEqual(dependencyOrder(graph));
      for (const [name, { dependsOn }] of Object.entries(graph)) for (const dependency of dependsOn) expect(order.indexOf(dependency)).toBeLessThan(order.indexOf(name));
    }
  });
});

describe("infrastructure planning", () => {
  it("produces stable, verifiable digests and changes them when inputs change", () => {
    const first = planInfrastructure({ intent, bindings: binding(), environment: "staging", observation: observation(), toolchain: SUPPORTED_TOOLCHAIN, now });
    const second = planInfrastructure({ intent: parseIntent(stringify(intentDocument)), bindings: binding(), environment: "staging", observation: observation(), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(second.digest).toBe(first.digest);
    expect(verifyPlanDigest(first)).toBe(true);
    expect(verifyPlanDigest({ ...first, environment: "production" })).toBe(false);
    expect(verifyPlanDigest({ ...first, operations: first.operations.map((operation) => ({ ...operation, classification: "no_change" as const })) })).toBe(false);
    const otherAccount = planInfrastructure({ intent, bindings: binding(), environment: "staging", observation: observation({ observedAt: "2026-10-01T23:59:30.000Z" }), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(otherAccount.digest).not.toBe(first.digest);
  });

  it("orders operations by dependency and leaves new identities unresolved until journaled", () => {
    const plan = planInfrastructure({ intent, bindings: binding(), environment: "staging", observation: observation(), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(plan.operations.map((operation) => operation.resource)).toEqual(["database", "email"]);
    expect(plan.operations[0]).toMatchObject({ classification: "blocked", target: "pending:op-staging-database", capability: { operation: "create", allowed: false } });
    expect(plan.operations[1]!.dependsOn).toEqual(["op-staging-database"]);
  });

  it("blocks creation while capability evidence is not hosted-verified, without claiming support", () => {
    const plan = planInfrastructure({ intent, bindings: binding(), environment: "staging", observation: observation(), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(planIsExecutable(plan)).toBe(false);
    expect(plan.operations[0]!.blockers.join("\n")).toMatch(/create: unknown: response-loss reconciliation/u);
  });

  it("treats component pricing without a free plan, and account-scoped plans, as requiring authorization", () => {
    const plan = planInfrastructure({ intent, bindings: binding(), environment: "staging", observation: observation(), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(plan.operations[0]!.cost).toMatchObject({ kind: "free", requiresAuthorization: false });
    expect(plan.operations[1]!.cost).toMatchObject({ kind: "unknown", requiresAuthorization: true });
    expect(plan.operations[1]!.blockers.join("\n")).toMatch(/unknown and cannot be treated as free/u);
    const resend = parseIntent(stringify({ ...intentDocument, environments: { staging: { projectsBinding: "s", resources: { email: { provider: "resend", service: "email", plan: "free" } } } } }));
    const account = planInfrastructure({ intent: resend, bindings: binding(), environment: "staging", observation: observation(), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(account.operations[0]!.cost).toMatchObject({ kind: "free", accountWide: true, requiresAuthorization: true });
    expect(account.operations[0]!.blockers.join("\n")).toMatch(/costLimit/u);
    const paid = parseIntent(stringify({ ...intentDocument, environments: { staging: { projectsBinding: "s", resources: { database: { provider: "neon", service: "postgres", plan: "launch" } } } } }));
    expect(planInfrastructure({ intent: paid, bindings: binding(), environment: "staging", observation: observation(), toolchain: SUPPORTED_TOOLCHAIN, now }).operations[0]!.cost).toMatchObject({ kind: "paid", recurring: true, requiresAuthorization: true });
  });

  it("refuses to plan against a different account, project or environment than the binding", () => {
    const bound = binding({ database: { provider: "neon", service: "postgres", plan: "free", externalId: "neon-proj-1", lifecycleOwner: "stripe-projects", boundBy: "op-1" } });
    for (const drift of [{ stripeAccountId: "acct_9999999999" }, { projectsProjectId: "proj_other" }, { projectsEnvironment: "production" }]) {
      const plan = planInfrastructure({ intent, bindings: bound, environment: "staging", observation: observation(drift), toolchain: SUPPORTED_TOOLCHAIN, now });
      expect(plan.blockers.join("\n")).toMatch(/differs from bound/u);
      expect(planIsExecutable(plan)).toBe(false);
    }
  });

  it("detects drift of a bound resource rather than recreating it", () => {
    const bound = binding({ database: { provider: "neon", service: "postgres", plan: "free", externalId: "neon-proj-1", lifecycleOwner: "stripe-projects", boundBy: "op-1" } });
    const missing = planInfrastructure({ intent, bindings: bound, environment: "staging", observation: observation(), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(missing.operations[0]).toMatchObject({ classification: "blocked", target: "neon-proj-1" });
    expect(missing.operations[0]!.blockers.join(" ")).toMatch(/not found in the observed environment/u);
    const partial = planInfrastructure({ intent, bindings: bound, environment: "staging", observation: observation({ complete: false }), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(partial.operations[0]!.blockers.join(" ")).toMatch(/discovery was incomplete/u);
    const present = planInfrastructure({ intent, bindings: bound, environment: "staging", observation: observation({ resources: [{ externalId: "neon-proj-1", provider: "neon", service: "postgres", plan: "free" }] }), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(present.operations[0]).toMatchObject({ classification: "no_change" });
    const tier = planInfrastructure({ intent, bindings: bound, environment: "staging", observation: observation({ resources: [{ externalId: "neon-proj-1", provider: "neon", service: "postgres", plan: "launch" }] }), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(tier.operations[0]).toMatchObject({ classification: "blocked", capability: { operation: "tier_change" } });
  });

  it("blocks an in-place ownership or service change of a bound resource", () => {
    const external = binding({ database: { provider: "neon", service: "postgres", plan: "free", externalId: "neon-proj-1", lifecycleOwner: "external", boundBy: "op-1" } });
    const seen = observation({ resources: [{ externalId: "neon-proj-1", provider: "neon", service: "postgres", plan: "free" }] });
    const plan = planInfrastructure({ intent, bindings: external, environment: "staging", observation: seen, toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(plan.operations[0]).toMatchObject({ classification: "blocked" });
    expect(plan.operations[0]!.blockers.join(" ")).toMatch(/explicit ownership handoff/u);
  });

  it("does not treat a same-named unbound resource as identity", () => {
    const plan = planInfrastructure({ intent, bindings: binding(), environment: "staging", observation: observation({ resources: [{ externalId: "neon-proj-x", provider: "neon", service: "postgres", name: "database" }] }), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(plan.operations[0]!.blockers.join(" ")).toMatch(/names are not identity/u);
  });

  it("labels offline plans stale and never executable", () => {
    const plan = planInfrastructure({ intent, bindings: binding(), environment: "staging", toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(plan).toMatchObject({ stale: true, observedAt: null });
    expect(planIsExecutable(plan)).toBe(false);
  });

  it("blocks without a verified toolchain or a reviewed environment binding", () => {
    const plan = planInfrastructure({ intent, bindings: parseBindings('{"schemaVersion":1,"environments":{}}'), environment: "staging", observation: observation(), now });
    expect(plan.blockers.join("\n")).toMatch(/toolchain is unavailable/u);
    expect(plan.blockers.join("\n")).toMatch(/no reviewed Projects binding/u);
    expect(plan.target).toBeNull();
  });

  it("rejects undeclared cross-environment sharing of one external resource", () => {
    const shared: InfrastructureBindings = parseBindings(JSON.stringify({
      schemaVersion: 1,
      environments: {
        staging: { trestleProjectId: "t", stripeAccountId: "acct_1234567890", projectsProjectId: "proj_abc", projectsEnvironment: "staging", generation: 1, resources: { database: { provider: "neon", service: "postgres", externalId: "neon-proj-1", lifecycleOwner: "stripe-projects", boundBy: "op" } } },
        production: { trestleProjectId: "t", stripeAccountId: "acct_1234567890", projectsProjectId: "proj_abc", projectsEnvironment: "production", generation: 1, resources: { database: { provider: "neon", service: "postgres", externalId: "neon-proj-1", lifecycleOwner: "stripe-projects", boundBy: "op" } } },
      },
    }));
    const plan = planInfrastructure({ intent, bindings: shared, environment: "staging", observation: observation(), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(plan.blockers.join("\n")).toMatch(/without an explicit sharedWith declaration/u);
  });

  it("reports orphaned bindings without planning their deletion", () => {
    const bound = binding({ legacy: { provider: "neon", service: "postgres", externalId: "neon-old", lifecycleOwner: "stripe-projects", boundBy: "op-0" } });
    const plan = planInfrastructure({ intent, bindings: bound, environment: "staging", observation: observation(), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(plan.orphans).toEqual(["legacy"]);
    expect(plan.operations.some((operation) => operation.classification === "delete" || operation.resource === "legacy")).toBe(false);
  });

  it("keeps resources owned by direct or external writers out of Projects mutation", () => {
    const direct = parseIntent(stringify({ ...intentDocument, environments: { staging: { projectsBinding: "s", resources: { database: { provider: "neon", service: "postgres", lifecycleOwner: "direct" } } } } }));
    const plan = planInfrastructure({ intent: direct, bindings: binding(), environment: "staging", observation: observation(), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(plan.operations[0]).toMatchObject({ classification: "no_change", capability: { operation: "inspect" } });
  });

  it("contains no secret values and performs no I/O", () => {
    const plan = planInfrastructure({ intent, bindings: binding(), environment: "staging", observation: observation(), toolchain: SUPPORTED_TOOLCHAIN, now });
    expect(JSON.stringify(plan)).not.toMatch(/postgres:\/\/|sk_live|whsec_/u);
    expect(plan.operations[0]!.credentialOutputs).toEqual(["DATABASE_URL"]);
    expect(plan.expiresAt).toBe("2026-10-02T01:00:00.000Z");
  });
});

describe("single writer and least-privilege projection (P11, P12)", () => {
  const hostedRow = (scopes?: Record<string, "least_privilege" | "owner" | "unknown">) => (provider: string, service: string, operation: import("../src/infra/capabilities.js").InfraOperation) => {
    const row = capabilityFor(provider, service, operation);
    return row ? { ...row, evidence: "hosted_verified" as const, unknowns: [], ...(scopes ? { credentialScopes: scopes } : {}) } : undefined;
  };
  const plan = (document: object, scopes?: Record<string, "least_privilege" | "owner" | "unknown">) => planInfrastructure({ intent: parseIntent(stringify(document)), bindings: binding(), environment: "staging", observation: observation(), toolchain: SUPPORTED_TOOLCHAIN, now, capabilities: hostedRow(scopes) });
  const env = (resources: object) => ({ schemaVersion: 1, backend: "stripe-projects", environments: { staging: { projectsBinding: "s", resources } } });

  it("blocks Projects ownership of a kind a generated script still writes", () => {
    const bucket = { provider: "cloudflare", service: "r2:bucket", costLimit: { currency: "usd", monthlyMinor: 500 } };
    expect(plan(env({ assets: bucket })).operations[0]!.blockers.join(" ")).toMatch(/cloudflare-r2\.mjs .* directWriterDisabled/u);
    expect(plan(env({ assets: { ...bucket, directWriterDisabled: true } })).operations[0]!.blockers.join(" ")).not.toMatch(/directWriterDisabled/u);
  });

  it("refuses to project an owner or unproven credential to application consumers", () => {
    const resend = { provider: "resend", service: "email", plan: "free", costLimit: { currency: "usd", monthlyMinor: 0 }, credentialBindings: { sending: { output: "RESEND_API_KEY", classification: "provider-managed", consumers: ["worker"] } } };
    expect(plan(env({ email: resend })).operations[0]!.blockers.join(" ")).toMatch(/RESEND_API_KEY has unknown privilege/u);
    expect(plan(env({ email: resend }), { RESEND_API_KEY: "owner" }).operations[0]!.blockers.join(" ")).toMatch(/owner privilege/u);
    expect(plan(env({ email: resend }), { RESEND_API_KEY: "least_privilege" }).operations[0]!.blockers).toEqual([]);
    const neon = { provider: "neon", service: "postgres", plan: "free", credentialBindings: { owner: { output: "DATABASE_URL", classification: "provider-managed", consumers: ["worker"] } } };
    expect(plan(env({ database: neon })).operations[0]!.blockers.join(" ")).toMatch(/derive a scoped runtime credential/u);
    const operator = { ...neon, credentialBindings: { owner: { output: "DATABASE_URL", classification: "operator-only" } } };
    expect(plan(env({ database: operator })).operations[0]!.blockers).toEqual([]);
  });
});
