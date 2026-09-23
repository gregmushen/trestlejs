import { describe, expect, it } from "vitest";

import { parseSetupPlan, SetupPlanError } from "../src/index.js";

const validPlan = {
  schemaVersion: 1,
  minimumTrestleVersion: "0.1.0-alpha.5",
  project: { name: "paper-route" },
  apps: { site: true, app: true, worker: true },
  tenancy: { model: "organization", enforcement: "postgres-rls" },
  database: { engine: "postgresql", provider: "neon" },
  capabilities: { r2: true, queues: true, workflows: true, durableObjects: false, admin: false },
  integrations: { email: true, billing: false },
  environments: ["local", "staging", "production"],
  secrets: [{ name: "DATABASE_URL", target: "worker", required: ["local"] }],
  resources: [{ name: "Article", tenant: true, crud: true }],
  externalResources: [],
  destructiveOperations: [],
  verification: { commands: ["pnpm check"] },
} as const;

describe("SetupPlan", () => {
  it("parses a versioned, secret-free plan", () => {
    expect(parseSetupPlan(JSON.stringify(validPlan)).resources[0]?.name).toBe("Article");
  });

  it("rejects unapproved paid resources", () => {
    const input = { ...validPlan, externalResources: [{ name: "database", environment: "production", paid: true, estimatedMonthlyCost: "$20", approved: false }] };
    expect(() => parseSetupPlan(JSON.stringify(input))).toThrow(SetupPlanError);
  });

  it("rejects duplicate resource names", () => {
    const input = { ...validPlan, resources: [validPlan.resources[0], validPlan.resources[0]] };
    expect(() => parseSetupPlan(JSON.stringify(input))).toThrow("SetupPlan is invalid");
  });

  it("accepts optional admin, provider, access, commercial, and artifact sections", () => {
    const plan = parseSetupPlan(JSON.stringify({
      ...validPlan,
      apps: { ...validPlan.apps, admin: true },
      capabilities: { ...validPlan.capabilities, admin: true },
      providers: { email: "resend", payments: "stripe" },
      access: { customRoles: true, serviceAccounts: true, apiKeys: true },
      commercial: { plans: true, usage: true },
      artifacts: { storage: "local", retentionDays: 30 },
    }));
    expect(plan.apps.admin).toBe(true);
    expect(plan.providers?.payments).toBe("stripe");
    expect(parseSetupPlan(JSON.stringify(validPlan)).providers).toBeUndefined();
  });

  it("enforces cross-field requirements", () => {
    const issues = (input: object) => {
      try { parseSetupPlan(JSON.stringify(input)); return []; }
      catch (error) { return (error as SetupPlanError).issues.map((issue) => issue.path.join(".")); }
    };
    expect(issues({ ...validPlan, access: { customRoles: false, serviceAccounts: false, apiKeys: true } })).toContain("access.apiKeys");
    expect(issues({ ...validPlan, providers: { email: "local", payments: "lago" } })).toContain("providers.payments");
    expect(issues({ ...validPlan, providers: { email: "local", payments: "lago" }, commercial: { plans: true, usage: false } })).toEqual([]);
    expect(issues({ ...validPlan, apps: { ...validPlan.apps, admin: true } })).toContain("apps.admin");
    expect(issues({ ...validPlan, artifacts: { storage: "s3", retentionDays: 10 } })).toContain("artifacts.storage");
  });
});
