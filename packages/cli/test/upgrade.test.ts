import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TRESTLEJS_VERSION } from "../src/core.js";
import { applyUpgrade, planUpgrade } from "../src/upgrade.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

describe("versioned project upgrades", () => {
  it("plans without mutation and applies convergently while preserving custom guidance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-upgrade-")); roots.push(root);
    await mkdir(path.join(root, ".trestle"));
    await mkdir(path.join(root, ".agents", "skills", "trestle-setup"), { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"devDependencies":{"trestlejs":"0.1.0-alpha.8"}}\n');
    await writeFile(path.join(root, ".agents", "skills", "trestle-setup", "SKILL.md"), "---\nname: trestle-setup\n---\n\n# Custom guidance\n");
    const initial = await planUpgrade(root);
    expect(initial.operations.filter(({ classification }) => classification === "manual-review")).toHaveLength(4);
    expect(await readFile(path.join(root, "package.json"), "utf8")).toContain("alpha.8");
    await expect(applyUpgrade(root)).rejects.toThrow("Upgrade requires manual review");
    expect(await readFile(path.join(root, "package.json"), "utf8")).toContain("alpha.8");
    for (const directory of ["packages/context/src", "apps/worker/src", "packages/db/src", "packages/db/migrations", "packages/billing/src", "scripts"]) await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, "packages/context/src/index.ts"), "export const AUTHORITY_MODEL_VERSION = 3;\n");
    await writeFile(path.join(root, "apps/worker/src/execution-context.ts"), "loadApplicationRoles: async () => [],\n");
    await writeFile(path.join(root, "packages/db/src/auth-schema.ts"), "export const applicationRole = 'contributor';\n");
    await writeFile(path.join(root, "packages/db/migrations/0019_access.sql"), 'CREATE TABLE "application_role_assignment" ("id" uuid);\n');
    await writeFile(path.join(root, "packages/db/src/index.ts"), "import 'drizzle-orm/neon-serverless';\n");
    await writeFile(path.join(root, "packages/db/src/roles.ts"), "export function verifyRuntimeRoleDataAccess() {}\n");
    await writeFile(path.join(root, "packages/billing/src/repository.ts"), "import { createTenantDatabase } from '@project/db';\n");
    await writeFile(path.join(root, "scripts/neon-preview.mjs"), "const runtimeUrl = await connectionUri(runtimeRole, false);\n");
    const originalMarker = `${JSON.stringify({ schemaVersion: 1, templateVersion: TRESTLEJS_VERSION, managedGuidanceVersion: 1 })}\n`;
    await writeFile(path.join(root, ".trestle", "framework.json"), originalMarker);
    await writeFile(path.join(root, ".trestle", "template-baseline.json"), `${JSON.stringify({ schemaVersion: 1, templateVersion: TRESTLEJS_VERSION, files: { ".trestle/framework.json": createHash("sha256").update(originalMarker).digest("hex") } })}\n`);
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({ devDependencies: { trestlejs: TRESTLEJS_VERSION } })}\n`);
    await writeFile(path.join(root, "pnpm-lock.yaml"), `importers:\n  .:\n    devDependencies:\n      trestlejs:\n        specifier: ${TRESTLEJS_VERSION}\n        version: ${TRESTLEJS_VERSION}\n`);
    await applyUpgrade(root);
    await applyUpgrade(root);
    expect(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).devDependencies.trestlejs).toBe(TRESTLEJS_VERSION);
    const skill = await readFile(path.join(root, ".agents", "skills", "trestle-setup", "SKILL.md"), "utf8");
    expect(skill).toContain("# Custom guidance");
    expect(skill.match(/trestle-managed-guidance/g)).toHaveLength(1);
    const currentMarker = await readFile(path.join(root, ".trestle", "framework.json"), "utf8");
    const baseline = JSON.parse(await readFile(path.join(root, ".trestle", "template-baseline.json"), "utf8"));
    expect(baseline.files[".trestle/framework.json"]).toBe(createHash("sha256").update(currentMarker).digest("hex"));
    expect((await planUpgrade(root)).operations.every(({ classification }) => classification === "already-correct")).toBe(true);
  });

  it("does not stamp old application-owned source as current when only the CLI is upgraded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-stale-template-")); roots.push(root);
    await mkdir(path.join(root, ".trestle"));
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({ devDependencies: { trestlejs: TRESTLEJS_VERSION } })}\n`);
    await writeFile(path.join(root, "pnpm-lock.yaml"), `importers:\n  .:\n    devDependencies:\n      trestlejs:\n        specifier: ${TRESTLEJS_VERSION}\n        version: ${TRESTLEJS_VERSION}\n`);
    const old = { schemaVersion: 1, templateVersion: "0.1.0-alpha.37", managedGuidanceVersion: 1 };
    await writeFile(path.join(root, ".trestle", "framework.json"), `${JSON.stringify(old)}\n`);
    const plan = await planUpgrade(root);
    expect(plan.operations).toContainEqual(expect.objectContaining({ id: "cli-version", classification: "already-correct" }));
    expect(plan.operations).toContainEqual(expect.objectContaining({ id: "template-source", classification: "manual-review", description: expect.stringContaining("alpha.37") }));
    await expect(applyUpgrade(root)).rejects.toThrow("Upgrade requires manual review");
    expect(JSON.parse(await readFile(path.join(root, ".trestle", "framework.json"), "utf8"))).toEqual(old);
  });

  it("refuses to record an upgrade when package.json and pnpm-lock.yaml disagree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-stale-lockfile-")); roots.push(root);
    await mkdir(path.join(root, ".trestle"));
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({ devDependencies: { trestlejs: TRESTLEJS_VERSION } })}\n`);
    await writeFile(path.join(root, "pnpm-lock.yaml"), "importers:\n  .:\n    devDependencies:\n      trestlejs:\n        specifier: 0.1.0-alpha.37\n        version: 0.1.0-alpha.37\n");
    await writeFile(path.join(root, ".trestle", "framework.json"), `${JSON.stringify({ schemaVersion: 1, templateVersion: TRESTLEJS_VERSION, managedGuidanceVersion: 1 })}\n`);
    const plan = await planUpgrade(root);
    expect(plan.operations).toContainEqual(expect.objectContaining({ id: "cli-version", classification: "manual-review" }));
    await expect(applyUpgrade(root)).rejects.toThrow("Upgrade requires manual review");
    expect((await readFile(path.join(root, "pnpm-lock.yaml"), "utf8"))).toContain("alpha.37");
  });

  it("flags a pre-upgrade backup-verify workflow that lacks the experimental opt-in for manual review", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-upgrade-backup-")); roots.push(root);
    await mkdir(path.join(root, ".trestle"));
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({ devDependencies: { trestlejs: TRESTLEJS_VERSION } })}\n`);
    await writeFile(
      path.join(root, ".github", "workflows", "backup-verify.yml"),
      [
        "on:",
        "  schedule:",
        "    - cron: \"17 10 * * 1\"",
        "steps:",
        "  - name: Verify isolated production restore",
        "    run: pnpm exec trestle backup verify --env production --to restore-test --yes --json",
        "    env:",
        "      TRESTLE_MASTER_KEY: \"${{ secrets.TRESTLE_MASTER_KEY }}\"",
        "",
      ].join("\n"),
    );
    const plan = await planUpgrade(root);
    expect(plan.operations).toContainEqual(expect.objectContaining({
      id: "backup-verify-experimental",
      classification: "manual-review",
      description: expect.stringContaining('add TRESTLE_EXPERIMENTAL: "1" to the env: of the trestle backup verify step in .github/workflows/backup-verify.yml'),
    }));
  });

  it("does not flag a freshly generated project's backup-verify workflow, which already opts in", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-upgrade-backup-fresh-")); roots.push(root);
    await mkdir(path.join(root, ".trestle"));
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({ devDependencies: { trestlejs: TRESTLEJS_VERSION } })}\n`);
    await cp(path.join("packages", "create", "template", ".github", "workflows", "backup-verify.yml"), path.join(root, ".github", "workflows", "backup-verify.yml"));
    const plan = await planUpgrade(root);
    expect(plan.operations).toContainEqual(expect.objectContaining({ id: "backup-verify-experimental", classification: "already-correct" }));
  });
});
