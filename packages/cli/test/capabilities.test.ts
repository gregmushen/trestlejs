import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseProjectManifest, setupPlanSchema, type ProjectManifest } from "@trestlejs/core";
import { afterEach, describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";
import { formatCapabilities, inspectCapabilities, writeEvidence } from "../src/capabilities.js";
import { formatDoctorHuman, runDoctor } from "../src/doctor.js";
import { applySetupPlan, diffSetupPlan, planFromManifest } from "../src/plan.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const baseManifest = `schemaVersion: 1
project:
  name: fixture
apps:
  app: apps/app
  worker: apps/worker
  admin: apps/admin
packages:
  authz: packages/authz
  billing: packages/billing
  integrations: packages/integrations
tenancy:
  model: organization
  enforcement: postgres-rls
database:
  engine: postgresql
  defaultProvider: neon
capabilities:
  r2: false
  queues: true
  workflows: false
  durableObjects: false
  admin: true
integrations:
  email: resend
  payments: stripe
access:
  customRoles: true
  serviceAccounts: true
  apiKeys: true
commercial:
  plans: true
  usage: false
environments: [local, staging, production]
secrets:
  RESEND_API_KEY:
    target: worker
    required: [staging, production]
  RESEND_WEBHOOK_SECRET:
    target: worker
    required: [staging, production]
  STRIPE_SECRET_KEY:
    target: worker
    required: [staging, production]
  STRIPE_WEBHOOK_SECRET:
    target: worker
    required: [staging, production]
`;

async function project(manifestText = baseManifest): Promise<{ root: string; manifest: ProjectManifest }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-capabilities-"));
  directories.push(root);
  await mkdir(path.join(root, ".trestle"), { recursive: true });
  await mkdir(path.join(root, ".agents", "skills", "trestle-setup"), { recursive: true });
  await writeFile(path.join(root, ".agents", "skills", "trestle-setup", "SKILL.md"), "fixture\n");
  await writeFile(path.join(root, ".trestle", "project.yaml"), manifestText);
  for (const directory of ["apps/app", "apps/worker"]) await mkdir(path.join(root, directory), { recursive: true });
  return { root, manifest: parseProjectManifest(manifestText) };
}

async function addSources(root: string): Promise<void> {
  for (const directory of ["apps/admin", "packages/authz", "packages/billing", "packages/integrations"]) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, "package.json"), "{}\n");
  }
  await writeFile(path.join(root, "apps/worker/wrangler.jsonc"), '{ "queues": { "producers": [{ "binding": "QUEUE", "queue": "fixture" }] } }\n');
}

const state = (report: Awaited<ReturnType<typeof inspectCapabilities>>, id: string) => report.capabilities.find((capability) => capability.id === id)!;

describe("capability lifecycle", () => {
  it("reports disabled, declared, and configured states with safe missing requirements", async () => {
    const { root, manifest } = await project();
    const declared = await inspectCapabilities(root, manifest, "local", { secrets: {} });
    expect(state(declared, "workflows")).toMatchObject({ state: "disabled", healthy: true, missing: [] });
    expect(state(declared, "admin")).toMatchObject({ state: "declared", healthy: false, missing: ["source apps/admin/package.json"], repair: "pnpm exec trestle setup" });
    expect(state(declared, "queues").missing[0]).toContain("binding QUEUE");
    expect(state(declared, "apiKeys").missing).toEqual(["source packages/authz/package.json"]);

    await addSources(root);
    const local = await inspectCapabilities(root, manifest, "local", { secrets: {} });
    for (const id of ["email", "payments", "admin", "queues", "plans", "serviceAccounts", "apiKeys"]) expect(state(local, id).state).toBe("configured");

    const staging = await inspectCapabilities(root, manifest, "staging", { secrets: { RESEND_API_KEY: "x" } });
    expect(state(staging, "email")).toMatchObject({ state: "declared", missing: ["secret RESEND_WEBHOOK_SECRET"], repair: "pnpm exec trestle setup --env staging" });
    expect(state(staging, "payments").missing).toEqual(["secret STRIPE_SECRET_KEY", "secret STRIPE_WEBHOOK_SECRET"]);
    const unknown = await inspectCapabilities(root, manifest, "staging");
    expect(state(unknown, "email").missing[0]).toContain("status unknown");
    expect(formatCapabilities(staging)).toContain("✗ payments         declared   missing secret STRIPE_SECRET_KEY, secret STRIPE_WEBHOOK_SECRET → pnpm exec trestle setup --env staging");
  });

  it("reports missing Lago declarations and derives deployed and verified only from evidence", async () => {
    const { root, manifest } = await project(baseManifest.replace("payments: stripe", "payments: lago"));
    await addSources(root);
    const secrets = { RESEND_API_KEY: "a", RESEND_WEBHOOK_SECRET: "b" };
    expect(state(await inspectCapabilities(root, manifest, "staging", { secrets }), "payments").missing).toEqual(["declaration LAGO_API_KEY in .trestle/project.yaml secrets"]);

    const evidence = { schemaVersion: 1 as const, environment: "staging" as const, recordedAt: "2026-09-22T00:00:00.000Z", capabilities: { email: { deployed: true, checkedAt: "x" }, queues: { deployed: true, verified: true, checkedAt: "x" }, admin: { verified: true, checkedAt: "x" } } };
    const report = await inspectCapabilities(root, manifest, "staging", { secrets, evidence });
    expect(state(report, "email").state).toBe("deployed");
    expect(state(report, "queues").state).toBe("verified");
    expect(state(report, "admin").state).toBe("configured");
    const local = await inspectCapabilities(root, manifest, "local", { secrets: {}, evidence: { ...evidence, environment: "local", capabilities: { admin: { verified: true, checkedAt: "x" }, email: { deployed: true, checkedAt: "x" } } } });
    expect(state(local, "admin").state).toBe("verified");
    expect(state(local, "email").state).toBe("configured");

    await writeEvidence(root, evidence);
    const cli = { stdout: "", runtime: { cwd: () => root, stdout: (text: string) => { cli.stdout += text; }, stderr: () => undefined } };
    expect(await executeCli(["capabilities", "--env", "staging", "--json"], cli.runtime)).toBe(0);
    const document = JSON.parse(cli.stdout) as { data: { capabilities: Array<{ id: string; state: string; missing: string[] }> } };
    expect(document.data.capabilities.find(({ id }) => id === "email")?.missing[0]).toContain("status unknown");
    expect(document.data.capabilities.find(({ id }) => id === "queues")?.state).toBe("verified");
  });

  it("adds Doctor capability warnings without failing Doctor", async () => {
    const { root, manifest } = await project();
    const report = await runDoctor(root, manifest, "local");
    const warning = report.checks.find((check) => check.id === "capabilities.admin");
    expect(warning).toMatchObject({ group: "capabilities", status: "warn", remediation: "Run: pnpm exec trestle setup" });
    expect(report.summary.warnings).toBeGreaterThan(0);
    expect(report.checks.filter((check) => check.group === "capabilities" && check.status === "fail")).toEqual([]);
    expect(formatDoctorHuman(report)).toContain("! Platform admin is declared but not configured for local");
  });
});

describe("SetupPlan capability sections", () => {
  it("derives a valid plan from the manifest and diffs, applies, and converges declarations", async () => {
    const { root, manifest } = await project();
    await addSources(root);
    const plan = planFromManifest(manifest);
    expect(setupPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.apps.admin).toBe(true);
    const input = JSON.stringify(plan);
    const converged = await diffSetupPlan(root, manifest, plan, input);
    expect(converged.items.filter((item) => item.classification !== "already correct")).toEqual([]);
    expect(converged.items.map(({ id }) => id)).toEqual(expect.arrayContaining(["apps.admin", "providers", "access", "commercial"]));

    const changed = { ...plan, providers: { email: "local" as const, payments: "local" as const }, artifacts: { storage: "r2" as const, retentionDays: 7 }, capabilities: { ...plan.capabilities, workflows: true } };
    const changedInput = JSON.stringify(changed);
    const diff = await diffSetupPlan(root, manifest, changed, changedInput);
    expect(diff.items).toContainEqual(expect.objectContaining({ id: "providers", classification: "update" }));
    expect(diff.items).toContainEqual(expect.objectContaining({ id: "artifacts", classification: "update" }));
    const applied = await applySetupPlan(root, manifest, changed, changedInput);
    expect(applied.operations.map(({ id }) => id)).toEqual(expect.arrayContaining(["providers", "artifacts", "capabilities"]));
    const updatedText = await readFile(path.join(root, ".trestle", "project.yaml"), "utf8");
    const updated = parseProjectManifest(updatedText);
    expect(updated.integrations).toEqual({ email: "local", payments: "local" });
    expect(updated.artifacts).toEqual({ storage: "r2", retentionDays: 7 });
    expect(updated.capabilities.workflows).toBe(true);
    expect(updatedText).toContain("RESEND_API_KEY");
    expect((await diffSetupPlan(root, updated, changed, changedInput)).converged).toBe(true);
  });

  it("blocks enabling an admin application that has no source declaration", async () => {
    const { root, manifest } = await project(baseManifest.replace("  admin: apps/admin\n", ""));
    const plan = planFromManifest(manifest);
    expect(plan.apps.admin).toBe(false);
    const enabled = { ...plan, apps: { ...plan.apps, admin: true } };
    const diff = await diffSetupPlan(root, manifest, enabled, JSON.stringify(enabled));
    expect(diff.items).toContainEqual(expect.objectContaining({ id: "apps.admin", classification: "blocked" }));
  });
});
