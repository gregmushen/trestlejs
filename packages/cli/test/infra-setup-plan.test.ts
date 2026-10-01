import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseSetupPlan, SetupPlanError } from "../src/setup-plan.js";
import { applySetupPlan, diffSetupPlan } from "../src/plan.js";
import { projectManifestSchema } from "../src/manifest.js";
import type { ProjectManifest } from "../src/core.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const base = { minimumTrestleVersion: "0.1.0", project: { name: "fixture" }, apps: { site: false, app: false, worker: false }, tenancy: { model: "organization", enforcement: "postgres-rls" }, database: { engine: "postgresql", provider: "neon" }, capabilities: { r2: false, queues: false, workflows: false, durableObjects: false, admin: false }, integrations: { email: false, billing: false }, environments: ["local", "staging"] };
const manifest = projectManifestSchema.parse({ schemaVersion: 1, project: { name: "fixture" }, apps: {}, packages: {}, tenancy: { model: "organization", enforcement: "postgres-rls" }, database: { engine: "postgresql", defaultProvider: "neon" }, capabilities: { r2: false, queues: false, workflows: false, durableObjects: false, admin: false }, environments: ["local", "staging"] }) as ProjectManifest;
const issues = (input: object) => { try { parseSetupPlan(JSON.stringify(input)); return ""; } catch (error) { return `${(error as Error).message} ${JSON.stringify((error as SetupPlanError).issues ?? [])}`; } };

describe("SetupPlan infrastructure extension", () => {
  it("keeps version 1 plans source-only: no infrastructure, no approval flags, no external operations", () => {
    expect(issues({ schemaVersion: 1, ...base })).toBe("");
    expect(issues({ schemaVersion: 1, ...base, infrastructure: { intent: ".trestle/infrastructure.yaml", environments: ["staging"] } })).toMatch(/require schemaVersion 2/u);
    expect(issues({ schemaVersion: 1, ...base, approved: true })).toMatch(/invalid/u);
    expect(issues({ schemaVersion: 2, ...base, approved: true })).toMatch(/invalid/u);
    expect(issues({ schemaVersion: 1, ...base, externalResources: [{ provider: "neon" }] })).toMatch(/externalResources are not supported/u);
  });

  it("accepts the reference only in version 2, never for local, and reports a newer schema clearly", () => {
    expect(issues({ schemaVersion: 2, ...base, infrastructure: { intent: ".trestle/infrastructure.yaml", environments: ["staging"] } })).toBe("");
    expect(issues({ schemaVersion: 2, ...base, infrastructure: { intent: ".trestle/infrastructure.yaml", environments: ["local"] } })).toMatch(/invalid/u);
    expect(issues({ schemaVersion: 2, ...base, infrastructure: { intent: "elsewhere.yaml", environments: ["staging"] } })).toMatch(/invalid/u);
    expect(issues({ schemaVersion: 3, ...base })).toMatch(/requires a newer trestle CLI/u);
  });

  it("shows infrastructure as external diff items from the same planner and stays converged for source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-setup-infra-"));
    directories.push(root);
    await mkdir(path.join(root, ".trestle"));
    await writeFile(path.join(root, ".trestle", "infrastructure.yaml"), "schemaVersion: 1\nbackend: stripe-projects\nenvironments:\n  staging:\n    projectsBinding: s\n    resources:\n      database: {provider: neon, service: postgres, plan: free}\n");
    const input = JSON.stringify({ schemaVersion: 2, ...base, infrastructure: { intent: ".trestle/infrastructure.yaml", environments: ["staging"] } });
    const diff = await diffSetupPlan(root, manifest, parseSetupPlan(input), input);
    const external = diff.items.filter((item) => item.classification === "external");
    expect(external).toEqual([{ id: "infrastructure.staging.database", classification: "external", summary: expect.stringMatching(/approved trestle infra apply/u) }]);
    // SetupPlan apply hands infrastructure off; it neither fails nor performs remote work.
    const state = await applySetupPlan(root, manifest, parseSetupPlan(input), input);
    expect(state.operations.find((operation) => operation.id === "infrastructure.staging.database")).toMatchObject({ status: "blocked", reason: expect.stringMatching(/no remote changes/u) });
  });

  it("blocks the diff item when infrastructure intent is invalid instead of ignoring it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-setup-infra-"));
    directories.push(root);
    await mkdir(path.join(root, ".trestle"));
    await writeFile(path.join(root, ".trestle", "infrastructure.yaml"), "schemaVersion: 1\nbackend: stripe-projects\napproved: true\nenvironments: {}\n");
    const input = JSON.stringify({ schemaVersion: 2, ...base, infrastructure: { intent: ".trestle/infrastructure.yaml", environments: ["staging"] } });
    const diff = await diffSetupPlan(root, manifest, parseSetupPlan(input), input);
    expect(diff.items.find((item) => item.id === "infrastructure")).toMatchObject({ classification: "blocked" });
    expect(diff.converged).toBe(false);
  });
});
