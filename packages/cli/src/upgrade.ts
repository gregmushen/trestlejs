import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

import { TRESTLEJS_VERSION } from "./core.js";

export const FRAMEWORK_METADATA_VERSION = 1;
export const MANAGED_GUIDANCE_VERSION = 1;

export type UpgradeOperation = Readonly<{
  id: "template-source" | "framework-metadata" | "managed-guidance" | "cli-version" | "authority-model" | "database-runtime" | "backup-verify-experimental";
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
  const lockfileSource = await optionalText(path.join(root, "pnpm-lock.yaml"));
  let lockedVersion: string | undefined;
  let lockedSpecifier: string | undefined;
  try {
    const lockfile = lockfileSource ? YAML.parse(lockfileSource) as { importers?: { "."?: { devDependencies?: { trestlejs?: { specifier?: string; version?: string } } } } } : undefined;
    lockedVersion = lockfile?.importers?.["."]?.devDependencies?.trestlejs?.version;
    lockedSpecifier = lockfile?.importers?.["."]?.devDependencies?.trestlejs?.specifier;
  } catch { /* An unreadable lockfile is a review gate, never evidence of compatibility. */ }
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
  const authorityCurrent = Boolean(context?.includes("AUTHORITY_MODEL_VERSION = 3") && executionContext?.includes("loadApplicationRoles") && migrations.includes('CREATE TABLE "application_role_assignment"'));
  const runtimeCurrent = Boolean(database?.includes("drizzle-orm/neon-serverless") && roles?.includes("verifyRuntimeRoleDataAccess") && billing?.includes("createTenantDatabase") && neonPreview?.includes("connectionUri(runtimeRole, false)"));
  const backupVerifyWorkflow = await optionalText(path.join(root, ".github", "workflows", "backup-verify.yml"));
  const backupVerifyMissingOptIn = Boolean(
    backupVerifyWorkflow
    && /trestle\s+backup(\s+verify)?/u.test(backupVerifyWorkflow)
    && !backupVerifyWorkflow.includes('TRESTLE_EXPERIMENTAL: "1"'),
  );
  const marker = `<!-- trestle-managed-guidance:${MANAGED_GUIDANCE_VERSION} -->`;
  return {
    installedVersion,
    targetVersion: TRESTLEJS_VERSION,
    operations: [
      { id: "template-source", classification: framework?.schemaVersion === FRAMEWORK_METADATA_VERSION && framework.templateVersion === TRESTLEJS_VERSION ? "already-correct" : "manual-review", description: framework?.templateVersion ? `application-owned source is recorded at ${framework.templateVersion}; review and migrate it before recording ${TRESTLEJS_VERSION}` : "application-owned source has no reviewed template version; review and migrate it before recording the current version" },
      { id: "framework-metadata", classification: framework?.schemaVersion === FRAMEWORK_METADATA_VERSION && framework.templateVersion === TRESTLEJS_VERSION ? "already-correct" : "update", description: "record the versioned template and managed-guidance contract" },
      { id: "managed-guidance", classification: framework?.managedGuidanceVersion === MANAGED_GUIDANCE_VERSION && skill?.includes(marker) ? "already-correct" : "update", description: "refresh only the managed setup-skill marker while preserving application-owned guidance" },
      { id: "cli-version", classification: installedVersion === TRESTLEJS_VERSION && lockedSpecifier === TRESTLEJS_VERSION && lockedVersion === TRESTLEJS_VERSION ? "already-correct" : "manual-review", description: `install trestlejs@${TRESTLEJS_VERSION} with pnpm so package.json and pnpm-lock.yaml agree` },
      { id: "authority-model", classification: authorityCurrent ? "already-correct" : "manual-review", description: "review application/organization authority separation and its database migration" },
      { id: "database-runtime", classification: runtimeCurrent ? "already-correct" : "manual-review", description: "review Neon transactional transport, restricted grants, tenant billing, and unpooled preview URLs" },
      { id: "backup-verify-experimental", classification: backupVerifyMissingOptIn ? "manual-review" : "already-correct", description: 'add TRESTLE_EXPERIMENTAL: "1" to the env: of the trestle backup verify step in .github/workflows/backup-verify.yml so the scheduled backup verify run keeps working after upgrading the CLI' },
    ],
  };
}

export async function applyUpgrade(root: string): Promise<UpgradePlan> {
  const before = await planUpgrade(root);
  if (before.operations.some(({ classification }) => classification === "manual-review")) {
    throw new Error("Upgrade requires manual review of application source or the package lockfile; run trestle upgrade plan");
  }
  const baselinePath = path.join(root, ".trestle", "template-baseline.json");
  const baselineSource = await optionalText(baselinePath);
  let baseline: { schemaVersion?: number; templateVersion?: string; files?: Record<string, string> } | undefined;
  if (baselineSource) {
    try { baseline = JSON.parse(baselineSource); }
    catch { throw new Error("Cannot update the generation baseline; review .trestle/template-baseline.json"); }
  }
  const skillPath = path.join(root, ".agents", "skills", "trestle-setup", "SKILL.md");
  const skill = await readFile(skillPath, "utf8");
  const marker = `<!-- trestle-managed-guidance:${MANAGED_GUIDANCE_VERSION} -->`;
  if (!skill.includes(marker)) await writeFile(skillPath, `${skill.trimEnd()}\n\n${marker}\n`, "utf8");

  const markerSource = `${JSON.stringify({ schemaVersion: FRAMEWORK_METADATA_VERSION, templateVersion: TRESTLEJS_VERSION, managedGuidanceVersion: MANAGED_GUIDANCE_VERSION, upgradedAt: new Date().toISOString() }, null, 2)}\n`;
  await writeFile(path.join(root, ".trestle", "framework.json"), markerSource, "utf8");
  if (baseline?.schemaVersion === 1 && baseline.templateVersion === TRESTLEJS_VERSION && baseline.files?.[".trestle/framework.json"]) {
    baseline.files[".trestle/framework.json"] = createHash("sha256").update(markerSource).digest("hex");
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  }
  await writeFile(path.join(root, ".trestle", "upgrade-state.json"), `${JSON.stringify({ schemaVersion: 1, from: before.installedVersion, to: TRESTLEJS_VERSION, operations: before.operations.filter(({ classification }) => classification === "update").map(({ id }) => id), completedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return before;
}

export function formatUpgradePlan(plan: UpgradePlan): string {
  const hasManualReview = plan.operations.some(({ classification }) => classification === "manual-review");
  return [`Upgrade ${plan.installedVersion} → ${plan.targetVersion}`, ...plan.operations.map((operation) => `${operation.classification.padEnd(17)} ${operation.id} — ${operation.description}`), hasManualReview ? "Review application-owned source and install the target CLI with its lockfile before upgrade apply can record this project as current." : plan.operations.every(({ classification }) => classification === "already-correct") ? "Project is current." : "Review the plan, then run trestle upgrade apply --yes.", ""].join("\n");
}
