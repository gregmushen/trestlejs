import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TRESTLEJS_VERSION } from "@trestlejs/core";
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
    expect(initial.operations.filter(({ classification }) => classification === "manual-review")).toHaveLength(2);
    expect(await readFile(path.join(root, "package.json"), "utf8")).toContain("alpha.8");
    await expect(applyUpgrade(root)).rejects.toThrow("Application-owned source requires manual review");
    expect(await readFile(path.join(root, "package.json"), "utf8")).toContain("alpha.8");
    for (const directory of ["packages/context/src", "apps/worker/src", "packages/db/src", "packages/db/migrations", "packages/billing/src", "scripts"]) await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, "packages/context/src/index.ts"), "export const AUTHORITY_MODEL_VERSION = 2;\n");
    await writeFile(path.join(root, "apps/worker/src/execution-context.ts"), "const applicationRole = 'contributor';\n");
    await writeFile(path.join(root, "packages/db/src/auth-schema.ts"), "export const applicationRole = 'contributor';\n");
    await writeFile(path.join(root, "packages/db/migrations/0007_authority.sql"), 'ALTER TABLE "member" ADD COLUMN "application_role" text;\n');
    await writeFile(path.join(root, "packages/db/src/index.ts"), "import 'drizzle-orm/neon-serverless';\n");
    await writeFile(path.join(root, "packages/db/src/roles.ts"), "export function verifyRuntimeRoleDataAccess() {}\n");
    await writeFile(path.join(root, "packages/billing/src/repository.ts"), "import { createTenantDatabase } from '@project/db';\n");
    await writeFile(path.join(root, "scripts/neon-preview.mjs"), "const runtimeUrl = await connectionUri(runtimeRole, false);\n");
    await applyUpgrade(root);
    await applyUpgrade(root);
    expect(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).devDependencies.trestlejs).toBe(TRESTLEJS_VERSION);
    const skill = await readFile(path.join(root, ".agents", "skills", "trestle-setup", "SKILL.md"), "utf8");
    expect(skill).toContain("# Custom guidance");
    expect(skill.match(/trestle-managed-guidance/g)).toHaveLength(1);
    expect((await planUpgrade(root)).operations.every(({ classification }) => classification === "already-correct")).toBe(true);
  });
});
