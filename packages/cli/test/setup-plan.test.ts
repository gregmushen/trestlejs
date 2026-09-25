import { describe, expect, it } from "vitest";

import { parseSetupPlan, SetupPlanError } from "../src/core.js";

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
} as const;

describe("SetupPlan", () => {
  it("parses a versioned, secret-free plan", () => {
    expect(parseSetupPlan(JSON.stringify(validPlan)).resources[0]?.name).toBe("Article");
  });

  it("accepts empty legacy sections so earlier schemaVersion 1 plans still parse", () => {
    const legacy = { ...validPlan, externalResources: [], destructiveOperations: [], verification: { commands: ["pnpm check"] } };
    expect(parseSetupPlan(JSON.stringify(legacy)).resources[0]?.name).toBe("Article");
  });

  it("accepts an admin application, admin-targeted secrets, and optional empty requirements", () => {
    const input = { ...validPlan,
      apps: { ...validPlan.apps, admin: true },
      capabilities: { ...validPlan.capabilities, admin: true },
      secrets: [
        { name: "DATABASE_ADMIN_URL", target: "admin", required: ["staging", "production"] },
        { name: "ARTIFACT_SIGNING_SECRET", target: "worker", required: [] },
      ],
    };
    expect(parseSetupPlan(JSON.stringify(input))).toMatchObject({ apps: { admin: true }, secrets: input.secrets });
    expect(() => parseSetupPlan(JSON.stringify({ ...input, capabilities: { ...input.capabilities, admin: false } }))).toThrow(SetupPlanError);
  });

  it("rejects intents that trestle apply can never perform", () => {
    const external = { ...validPlan, externalResources: [{ name: "database", environment: "production" }] };
    expect(() => parseSetupPlan(JSON.stringify(external))).toThrow(SetupPlanError);
    const destructive = { ...validPlan, destructiveOperations: [{ description: "drop", environment: "production", approved: true }] };
    expect(() => parseSetupPlan(JSON.stringify(destructive))).toThrow(SetupPlanError);
  });

  it("only accepts tenant-owned CRUD resources", () => {
    const input = { ...validPlan, resources: [{ name: "Article", tenant: false }] };
    expect(() => parseSetupPlan(JSON.stringify(input))).toThrow(SetupPlanError);
    expect(parseSetupPlan(JSON.stringify({ ...validPlan, resources: [{ name: "Article" }] })).resources[0]).toMatchObject({ tenant: true, crud: true });
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

  it("keeps resource events private unless public webhook exposure is selected", () => {
    expect(parseSetupPlan(JSON.stringify(validPlan)).resources[0]?.webhookEvents).toEqual([]);
    const input = { ...validPlan, resources: [{ name: "Article", tenant: true, crud: true, webhookEvents: ["created", "updated"] }] };
    expect(parseSetupPlan(JSON.stringify(input)).resources[0]?.webhookEvents).toEqual(["created", "updated"]);
    const duplicate = { ...input, resources: [{ ...input.resources[0], webhookEvents: ["created", "created"] }] };
    expect(() => parseSetupPlan(JSON.stringify(duplicate))).toThrow(SetupPlanError);
  });
});
