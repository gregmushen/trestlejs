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

  it("reserves generated identity and revision fields", () => {
    const input = { ...validPlan, resources: [{ name: "Article", tenant: true, crud: true, fields: [
      { name: "name", type: "string", required: true },
      { name: "revision", type: "integer", required: false },
    ] }] };
    expect(() => parseSetupPlan(JSON.stringify(input))).toThrow(SetupPlanError);
  });
});
