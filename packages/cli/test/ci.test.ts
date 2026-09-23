import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateCi } from "../src/ci.js";

const temporaryDirectories: string[] = [];
const templateRoot = path.resolve("packages/create/template");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("generated CI deployment contract", () => {
  it("pins external Actions and uses the project-local Trestle CLI", async () => {
    const report = await validateCi(templateRoot);
    expect(report.valid).toBe(true);
    const pinned = report.checks.filter(({ id }) => id.endsWith("actions-pinned"));
    expect(pinned).toHaveLength(7);
    expect(pinned.every(({ status }) => status === "pass")).toBe(true);
    expect(report.checks.filter(({ id }) => id.endsWith("project-cli")).every(({ status }) => status === "pass")).toBe(true);
  });

  it("rejects mutable Action references", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    const workflowPath = path.join(root, ".github", "workflows", "ci.yml");
    const source = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, source.replace(/actions\/checkout@[0-9a-f]{40}/u, "actions/checkout@v4"));
    const report = await validateCi(root);
    expect(report.valid).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.workflow.ci.yml.actions-pinned", status: "fail", evidence: "actions/checkout@v4" }));
  });

  it("rejects provider verification that bypasses encrypted staging credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    const workflowPath = path.join(root, ".github", "workflows", "providers.yml");
    const source = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, source.replace("$(pnpm exec trestle secrets get RESEND_API_KEY --env staging --raw)", "${{ secrets.RESEND_API_KEY }}"));
    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.providers.encrypted-secrets", status: "fail" }));
  });

  it("rejects protected provider verification without staging configuration checks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    const workflowPath = path.join(root, ".github", "workflows", "providers.yml");
    const source = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, source.replace("pnpm exec trestle doctor --env staging", "pnpm exec trestle env status --env staging"));
    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.providers.encrypted-secrets", status: "fail" }));
  });

  it("rejects omission of the local product system test", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    const workflowPath = path.join(root, ".github", "workflows", "ci.yml");
    const source = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, source.replace("TRESTLE_SYSTEM_TEST_DATABASE_URL", "SKIP_SYSTEM_TEST_DATABASE_URL"));
    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.system.local", status: "fail" }));
  });

  it("rejects omission of durable inbox and outbox database tests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    const workflowPath = path.join(root, ".github", "workflows", "ci.yml");
    const source = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, source.replace("TRESTLE_INBOX_TEST_DATABASE_URL", "SKIP_INBOX_TEST_DATABASE_URL"));
    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.database.async", status: "fail" }));
  });

  it("rejects deployed smoke tests without an explicit environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    const previewPath = path.join(root, ".github", "workflows", "preview.yml");
    await writeFile(previewPath, (await readFile(previewPath, "utf8")).replace("TRESTLE_DEPLOY_ENV: preview", "TRESTLE_DEPLOY_ENV: staging"));
    const deployPath = path.join(root, ".github", "workflows", "deploy.yml");
    await writeFile(deployPath, (await readFile(deployPath, "utf8")).replace("TRESTLE_DEPLOY_ENV: production", "TRESTLE_DEPLOY_ENV: staging"));
    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.preview.operational-smoke", status: "fail" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.deploy.operational-smoke", status: "fail" }));
  });

  it("rejects runtime secrets declared only at the top level", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    await mkdir(path.join(root, "apps", "worker"), { recursive: true });
    await cp(path.join(templateRoot, "apps", "worker", "wrangler.jsonc"), path.join(root, "apps", "worker", "wrangler.jsonc"), { recursive: true });
    const configPath = path.join(root, "apps", "worker", "wrangler.jsonc");
    const source = await readFile(configPath, "utf8");
    await writeFile(configPath, source.replace(/("name": "__TRESTLE_PROJECT_NAME__-worker-preview",\n)\s*"secrets": \{ "required": \[[^\]]+\] \},/u, "$1"));
    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.worker.preview.secrets", status: "fail" }));
  });

  it("rejects missing preview provider secrets before deployment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    await mkdir(path.join(root, "apps", "worker"), { recursive: true });
    const configPath = path.join(root, "apps", "worker", "wrangler.jsonc");
    const source = await readFile(path.join(templateRoot, "apps", "worker", "wrangler.jsonc"), "utf8");
    await writeFile(configPath, source.replace('"RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"', '"RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"'));
    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.worker.preview.secrets", status: "fail" }));
  });

  it("rejects a workflow that downloads whatever CLI is currently latest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    const workflowPath = path.join(root, ".github", "workflows", "deploy.yml");
    await writeFile(workflowPath, `${await readFile(workflowPath, "utf8")}\n# pnpm dlx trestlejs@latest secrets check\n`);
    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.workflow.deploy.yml.project-cli", status: "fail" }));
  });

  it("rejects removal of preview teardown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    const workflowPath = path.join(root, ".github", "workflows", "preview.yml");
    const source = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, source.replaceAll("cloudflare-pages.mjs delete", "cloudflare-pages.mjs retain"));
    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.preview.cleanup", status: "fail" }));
  });

  it("rejects bypassing encrypted Neon preview credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    const workflowPath = path.join(root, ".github", "workflows", "preview.yml");
    const source = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, source.replaceAll("$(pnpm exec trestle secrets get NEON_API_KEY --env preview --raw)", "${{ secrets.NEON_API_KEY }}"));
    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.preview.encrypted-neon-credential", status: "fail" }));
  });

  it("rejects preview provisioning before Neon access is verified", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    const workflowPath = path.join(root, ".github", "workflows", "preview.yml");
    const source = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, source.replace("node scripts/neon-preflight.mjs", "node scripts/skip-neon-preflight.mjs"));
    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.preview.provider-preflight", status: "fail" }));
  });

  it("requires both provider probes to finish even if Cloudflare access fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    const workflowPath = path.join(root, ".github", "workflows", "preview.yml");
    const source = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, source.replace("- id: cloudflare_access\n        name: Verify Cloudflare access before provisioning\n        continue-on-error: true", "- id: cloudflare_access\n        name: Verify Cloudflare access before provisioning"));
    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.preview.provider-preflight", status: "fail" }));
  });

  it("requires preview preflight to check the configured Workers subdomain", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    const workflowPath = path.join(root, ".github", "workflows", "preview.yml");
    const source = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, source.replace('CLOUDFLARE_WORKERS_SUBDOMAIN: "${{ vars.CLOUDFLARE_WORKERS_SUBDOMAIN }}"', 'CLOUDFLARE_WORKERS_SUBDOMAIN: "wrong-account"'));
    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.preview.provider-preflight", status: "fail" }));
  });

  it("rejects a preview whose authentication URL is not bound to the isolated application", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });
    const workflowPath = path.join(root, ".github", "workflows", "preview.yml");
    const source = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, source.replace("secret put BETTER_AUTH_URL", "secret put STATIC_AUTH_URL"));
    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.preview.dynamic-auth-url", status: "fail" }));
  });

  it("rejects database role configuration before migrations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-ci-"));
    temporaryDirectories.push(root);
    await cp(path.join(templateRoot, ".github"), path.join(root, ".github"), { recursive: true });

    const previewPath = path.join(root, ".github", "workflows", "preview.yml");
    const preview = await readFile(previewPath, "utf8");
    await writeFile(previewPath, preview
      .replace("Migrate preview database", "ROLE_SETUP_PLACEHOLDER")
      .replace("Configure preview database roles", "Migrate preview database")
      .replace("ROLE_SETUP_PLACEHOLDER", "Configure preview database roles"));

    const deployPath = path.join(root, ".github", "workflows", "deploy.yml");
    const deploy = await readFile(deployPath, "utf8");
    await writeFile(deployPath, deploy
      .replace("Migrate staging", "ROLE_SETUP_PLACEHOLDER")
      .replace("Configure staging database roles", "Migrate staging")
      .replace("ROLE_SETUP_PLACEHOLDER", "Configure staging database roles"));

    const report = await validateCi(root);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.preview.migrate-before-role", status: "fail" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "ci.deploy.migrate-before-role", status: "fail" }));
  });
});
