import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { TRESTLEJS_VERSION } from "@trestlejs/core";

export const FRAMEWORK_METADATA_VERSION = 1;
export const MANAGED_GUIDANCE_VERSION = 1;

export type UpgradeOperation = Readonly<{
  id: "framework-metadata" | "managed-guidance" | "cli-version" | "authority-model" | "database-runtime";
  classification: "already-correct" | "update" | "manual-review";
  description: string;
}>;

export type UpgradePlan = Readonly<{
  installedVersion: string;
  targetVersion: string;
  operations: readonly UpgradeOperation[];
}>;

async function optionalText(target: string): Promise<string | undefined> {
  return readFile(target, "utf8").catch(() => undefined);
}

export async function planUpgrade(root: string): Promise<UpgradePlan> {
  const packagePath = path.join(root, "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { devDependencies?: Record<string, string> };
  const installedVersion = manifest.devDependencies?.trestlejs ?? "unknown";
  const frameworkSource = await optionalText(path.join(root, ".trestle", "framework.json"));
  const framework = frameworkSource ? JSON.parse(frameworkSource) as { schemaVersion?: number; templateVersion?: string; managedGuidanceVersion?: number } : undefined;
  const skill = await optionalText(path.join(root, ".agents", "skills", "trestle-setup", "SKILL.md"));
  const context = await optionalText(path.join(root, "packages", "context", "src", "index.ts"));
  const executionContext = await optionalText(path.join(root, "apps", "worker", "src", "execution-context.ts"));
  const authSchema = await optionalText(path.join(root, "packages", "db", "src", "auth-schema.ts"));
  const database = await optionalText(path.join(root, "packages", "db", "src", "index.ts"));
  const roles = await optionalText(path.join(root, "packages", "db", "src", "roles.ts"));
  const billing = await optionalText(path.join(root, "packages", "billing", "src", "repository.ts"));
  const neonPreview = await optionalText(path.join(root, "scripts", "neon-preview.mjs"));
  const migrationDirectory = path.join(root, "packages", "db", "migrations");
  const migrationFiles = (await readdir(migrationDirectory).catch(() => [])).filter((file) => file.endsWith(".sql"));
  const migrations = (await Promise.all(migrationFiles.map((file) => optionalText(path.join(migrationDirectory, file))))).join("\n");
  // Authority model 3: a permission registry with separately stored application-role assignments.
  const authorityCurrent = Boolean(context?.includes("AUTHORITY_MODEL_VERSION = 3") && executionContext?.includes("loadApplicationRoles") && authSchema?.includes("roleSource") && migrations.includes('CREATE TABLE "application_role_assignment"'));
  const runtimeCurrent = Boolean(database?.includes("drizzle-orm/neon-serverless") && roles?.includes("verifyRuntimeRoleDataAccess") && (billing?.includes("createTenantDatabase") || billing?.includes("tenantConnectionString")) && neonPreview?.includes("connectionUri(runtimeRole, false)"));
  const marker = `<!-- trestle-managed-guidance:${MANAGED_GUIDANCE_VERSION} -->`;
  return {
    installedVersion,
    targetVersion: TRESTLEJS_VERSION,
    operations: [
      { id: "framework-metadata", classification: framework?.schemaVersion === FRAMEWORK_METADATA_VERSION && framework.templateVersion === TRESTLEJS_VERSION ? "already-correct" : "update", description: "record the versioned template and managed-guidance contract" },
      { id: "managed-guidance", classification: framework?.managedGuidanceVersion === MANAGED_GUIDANCE_VERSION && skill?.includes(marker) ? "already-correct" : "update", description: "refresh only the managed setup-skill marker while preserving application-owned guidance" },
      { id: "cli-version", classification: installedVersion === TRESTLEJS_VERSION ? "already-correct" : "update", description: `pin the project CLI to ${TRESTLEJS_VERSION}` },
      { id: "authority-model", classification: authorityCurrent ? "already-correct" : "manual-review", description: "review application/organization authority separation and its database migration" },
      { id: "database-runtime", classification: runtimeCurrent ? "already-correct" : "manual-review", description: "review Neon transactional transport, restricted grants, tenant billing, and unpooled preview URLs" },
    ],
  };
}

export async function applyUpgrade(root: string): Promise<UpgradePlan> {
  const before = await planUpgrade(root);
  if (before.operations.some(({ classification }) => classification === "manual-review")) {
    throw new Error("Application-owned source requires manual review before this upgrade can be recorded; run trestle upgrade plan");
  }
  const packagePath = path.join(root, "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { devDependencies?: Record<string, string> };
  manifest.devDependencies ??= {};
  manifest.devDependencies.trestlejs = TRESTLEJS_VERSION;
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const skillPath = path.join(root, ".agents", "skills", "trestle-setup", "SKILL.md");
  const skill = await readFile(skillPath, "utf8");
  const marker = `<!-- trestle-managed-guidance:${MANAGED_GUIDANCE_VERSION} -->`;
  if (!skill.includes(marker)) await writeFile(skillPath, `${skill.trimEnd()}\n\n${marker}\n`, "utf8");

  await writeFile(path.join(root, ".trestle", "framework.json"), `${JSON.stringify({ schemaVersion: FRAMEWORK_METADATA_VERSION, templateVersion: TRESTLEJS_VERSION, managedGuidanceVersion: MANAGED_GUIDANCE_VERSION, upgradedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, ".trestle", "upgrade-state.json"), `${JSON.stringify({ schemaVersion: 1, from: before.installedVersion, to: TRESTLEJS_VERSION, operations: before.operations.filter(({ classification }) => classification === "update").map(({ id }) => id), completedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return before;
}

export function formatUpgradePlan(plan: UpgradePlan): string {
  const hasManualReview = plan.operations.some(({ classification }) => classification === "manual-review");
  return [`Upgrade ${plan.installedVersion} → ${plan.targetVersion}`, ...plan.operations.map((operation) => `${operation.classification.padEnd(17)} ${operation.id} — ${operation.description}`), hasManualReview ? "Application-owned source needs a reviewed migration; upgrade apply will not mark this project current." : plan.operations.every(({ classification }) => classification === "already-correct") ? "Project is current." : "Review the plan, then run trestle upgrade apply --yes.", ""].join("\n");
}
