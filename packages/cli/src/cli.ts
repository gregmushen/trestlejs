import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  environmentNameSchema,
  structuredOutput,
  TRESTLEJS_VERSION,
} from "./core.js";
import { Command, CommanderError, InvalidArgumentError } from "commander";

import { formatCiValidation, validateCi } from "./ci.js";
import { checkArchitecture, formatArchitecture } from "./architecture.js";
import { parseRecoveryConnectionOutput, readRecoveryPolicy, recoveryEvidencePassed, recoveryStatusLabel, validateRecoveryArtifactBucket, validateRecoveryPoint, validateRecoveryTarget } from "./backup.js";
import { projectContext } from "./context.js";
import { formatDoctorHuman, formatDoctorJson, runDoctor } from "./doctor.js";
import { CliFailure, type CliRuntime } from "./runtime.js";
import { localEnvironment } from "./local.js";
import { buildLogTailArguments, tailSemanticLogs } from "./logs.js";
import { clearLocalEmail, formatEmail, formatEmailList, getLocalEmail, listLocalEmail, openLocalEmail } from "./email.js";
import { generateEmail } from "./generate-email.js";
import { generateAdminModule } from "./generate-admin-module.js";
import { addResourceField, generateResource, generateResourceMigration, names, parseResourceField } from "./generate-resource.js";
import { sharedEditorPermission } from "./generate-shared-resource.js";
import { adminReadPermission, enableAdminRead } from "./generate-admin-read.js";
import { formatStatus, localStatus, portConflicts, portOwner } from "./local-status.js";
import { assertLocalDatabaseUrl, freshDevelopmentPlan } from "./fresh.js";
import { formatEnvironmentStatus, inspectEnvironmentStatus } from "./environment-status.js";
import { inspectResources, inspectRoutes } from "./inspect.js";
import { inspectResourceRelations, migrateLegacyRelations, relationPreflightSql, runRelationPreflight, type ResourceRelation } from "./legacy-relations.js";
import { applySetupPlan, diffSetupPlan, formatPlanDiff, formatPlanJson, initSetupPlan, readApplyState, readSetupPlan } from "./plan.js";
import { assertOutboxRetentionCutoff, formatOutboxRetentionSummary, type OutboxRetentionSummary } from "./outbox-retention.js";
import { runCommand, runDevelopment } from "./processes.js";
import { emailDeploymentIssues, inspectResendSender, validEmailAddress, type RemoteEmailEnvironment } from "./resend-status.js";
import { reconcileStripeCatalog, validateStripeCatalog } from "./stripe-sync.js";
import { configureStripeWebhook } from "./stripe-webhook.js";
import { stripeDeploymentIssues, stripeServerKeyMatchesMode } from "./stripe-deployment.js";
import { wranglerEnvironmentBlock, wranglerStringVariable } from "./wrangler-config.js";
import { workflowArguments } from "./workflows.js";
import { applyUpgrade, formatUpgradePlan, planUpgrade } from "./upgrade.js";
import { formatProviderStatuses, providerStatuses } from "./providers.js";
import { applySourceUpgrade, sourceFileDiff, finalizeSourceUpgrade, formatSourceDiff, planSourceDiff } from "./upgrade-source.js";
import { auditMigrations, formatMigrationAudit, rebaseMigrations } from "./upgrade-migrations.js";
import {
  adminSecretValues,
  credentialsPaths,
  editSecrets,
  formatSecretDocument,
  initializeSecrets,
  parseSecretDocument,
  readSecrets,
  rotateMasterKey,
  SecretsError,
  validateSecrets,
  writeSecrets,
  type SecretValues,
} from "./secrets.js";

function environment(value: string) {
  const result = environmentNameSchema.safeParse(value);
  if (!result.success) {
    throw new InvalidArgumentError("expected local, preview, staging, or production");
  }
  return result.data;
}

function selectedMasterKey(runtime: CliRuntime): string | undefined {
  return runtime.environment?.("TRESTLE_MASTER_KEY") ?? process.env.TRESTLE_MASTER_KEY;
}

function runtimeValue(runtime: CliRuntime, name: string): string | undefined { return runtime.environment?.(name) ?? process.env[name]; }

async function recoveryEnvironment(root: string, targetEnvironment: ReturnType<typeof environment>, runtime: CliRuntime): Promise<NodeJS.ProcessEnv> {
  if (!(["staging", "production"] as const).includes(targetEnvironment as "staging" | "production")) throw new CliFailure("Neon recovery operations require staging or production");
  const values = await readSecrets(root, targetEnvironment, selectedMasterKey(runtime));
  const required = {
    NEON_API_KEY: values.NEON_API_KEY,
    NEON_PROJECT_ID: runtimeValue(runtime, "NEON_PROJECT_ID"),
    NEON_DATABASE: runtimeValue(runtime, "NEON_DATABASE"),
    NEON_MIGRATION_ROLE: runtimeValue(runtime, "NEON_MIGRATION_ROLE"),
    DATABASE_RUNTIME_ROLE: runtimeValue(runtime, "DATABASE_RUNTIME_ROLE"),
  };
  const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new CliFailure(`Neon recovery configuration is missing: ${missing.join(", ")}`);
  return { ...process.env, ...required,
    CLOUDFLARE_ACCOUNT_ID: runtimeValue(runtime, "CLOUDFLARE_ACCOUNT_ID") ?? "",
    R2_RECOVERY_ACCESS_KEY_ID: values.R2_RECOVERY_ACCESS_KEY_ID ?? "",
    R2_RECOVERY_SECRET_ACCESS_KEY: values.R2_RECOVERY_SECRET_ACCESS_KEY ?? "",
  };
}

function dotenv(values: Record<string, string>): string {
  return `${Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n")}\n`;
}

function reveal(values: Record<string, string>, format: "yaml" | "json" | "dotenv"): string {
  if (format === "json") return `${JSON.stringify(values, null, 2)}\n`;
  if (format === "dotenv") return dotenv(values);
  return formatSecretDocument(values);
}

/** Beta freezes only proven commands; the rest run only with an explicit, per-invocation opt-in. */
function experimental(command: Command, runtime: CliRuntime): Command {
  command.description(`[experimental] ${command.description()}`);
  command.hook("preAction", (_hooked, actionCommand) => {
    if (actionCommand.optsWithGlobals<{ experimental?: boolean }>().experimental === true || runtimeValue(runtime, "TRESTLE_EXPERIMENTAL") === "1") return;
    const names: string[] = [];
    for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
    throw new CliFailure(`${names.join(" ")} is experimental in beta and may change; rerun with --experimental or set TRESTLE_EXPERIMENTAL=1`);
  });
  return command;
}

export function createProgram(runtime: CliRuntime): Command {
  const program = new Command()
    .name("trestle")
    .description("Build and operate conventional TrestleJS applications")
    .version(TRESTLEJS_VERSION)
    .option("--cwd <path>", "start project discovery from this directory")
    .option("--experimental", "allow experimental beta commands for this invocation")
    .showSuggestionAfterError()
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: runtime.stdout,
      writeErr: runtime.stderr,
    });

  program
    .command("project")
    .description("describe the current TrestleJS project")
    .option("--json", "emit versioned structured output")
    .action(async (options: { json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      if (options.json) {
        runtime.stdout(
          `${JSON.stringify(
            structuredOutput({ root: context.root, manifest: context.manifest }),
            null,
            2,
          )}\n`,
        );
        return;
      }
      runtime.stdout(
        [
          context.manifest.project.name,
          `  root         ${context.root}`,
          `  tenancy      ${context.manifest.tenancy.model} (${context.manifest.tenancy.enforcement})`,
          `  database     ${context.manifest.database.engine} (${context.manifest.database.defaultProvider})`,
          `  environments ${context.manifest.environments.join(", ")}`,
          "",
        ].join("\n"),
      );
    });

  const env = program.command("env").description("inspect declared environments");
  env
    .command("status")
    .description("inspect one declared environment without contacting providers")
    .option("--env <environment>", "environment to inspect", environment, "local")
    .option("--json", "emit versioned structured output")
    .action(async (options: { env: ReturnType<typeof environment>; json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const status = await inspectEnvironmentStatus(context.root, context.manifest, options.env);
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput(status), null, 2)}\n` : formatEnvironmentStatus(status));
      if (!status.declared || status.applications.some(({ present }) => !present)) throw new CliFailure(`${options.env} environment is incomplete`);
    });

  const ci = program.command("ci").description("validate generated continuous-delivery configuration");
  ci.command("validate")
    .description("validate the static GitHub Actions deployment contract")
    .option("--json", "emit versioned structured output")
    .action(async (options: { json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const report = await validateCi(context.root);
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput(report), null, 2)}\n` : formatCiValidation(report));
      if (!report.valid) throw new CliFailure("CI deployment contract has failures");
    });

  const architecture = program.command("architecture").description("validate static application boundaries and managed guidance");
  architecture.command("check")
    .option("--json", "emit versioned structured output")
    .action(async (options: { json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const report = await checkArchitecture(context.root);
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput(report), null, 2)}\n` : formatArchitecture(report));
      if (!report.valid) throw new CliFailure("architecture contract has failures");
    });

  const upgrade = program.command("upgrade").description("plan and apply versioned, application-preserving project migrations");
  upgrade.command("diff")
    .description("inspect target-template paths without changing application-owned source")
    .option("--json", "emit versioned structured output")
    .option("--path <file>", "print the unified diff from the application's file to the target template's")
    .action(async (options: { json?: boolean; path?: string }, command: Command) => {
      const context = await projectContext(command, runtime);
      if (options.path) {
        const diff = await sourceFileDiff(context.root, context.manifest.project.name, options.path);
        runtime.stdout(diff || `${options.path} already matches the target template.\n`);
        return;
      }
      const report = await planSourceDiff(context.root, context.manifest.project.name);
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput(report), null, 2)}\n` : formatSourceDiff(report));
    });
  upgrade.command("migrations")
    .description("audit application and target migration journals without changing either chain")
    .option("--json", "emit versioned structured output")
    .option("--check", "fail when migration history differs or is invalid")
    .option("--rebase", "adopt the target's new migrations and renumber the application's after them, keeping SQL and timestamps")
    .option("--yes", "confirm --rebase")
    .action(async (options: { json?: boolean; check?: boolean; rebase?: boolean; yes?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      if (options.rebase) {
        if (!options.yes) throw new CliFailure("migrations --rebase renames application migration files and rewrites the journal and snapshots; rerun with --yes after committing your work");
        const rebased = await rebaseMigrations(context.root);
        if (options.json) { runtime.stdout(`${JSON.stringify(structuredOutput(rebased), null, 2)}\n`); return; }
        runtime.stdout(rebased.adopted.length || rebased.moved.length
          ? `Adopted ${rebased.adopted.join(", ") || "no framework migrations"}.\n${rebased.moved.map(({ from, to }) => `Renumbered ${from} → ${to}`).join("\n")}\nDatabases that already applied the renumbered migrations need \`pnpm db:migrate -- --apply-skipped\` once, which applies the framework migrations Drizzle would otherwise skip.\n`
          : "The migration journal already contains the target's migrations; nothing to rebase.\n");
        return;
      }
      const report = await auditMigrations(context.root);
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput(report), null, 2)}\n` : formatMigrationAudit(report));
      if (report.classification === "invalid") throw new CliFailure("migration journal audit is invalid");
      if (options.check && report.requiresReview) throw new CliFailure("migration history requires review");
    });
  upgrade.command("source-apply")
    .description("apply the adjacent release's template source: update pristine files, keep application-only edits, and three-way merge files both sides changed; does not certify the upgrade")
    .option("--yes", "confirm the reviewed source diff")
    .option("--accept <file...>", "apply these deployment or configuration files after reviewing each with trestle upgrade diff --path")
    .action(async (options: { yes?: boolean; accept?: string[] }, command: Command) => {
      if (!options.yes) throw new CliFailure("upgrade source-apply requires --yes after reviewing trestle upgrade diff");
      const context = await projectContext(command, runtime);
      const changed = await applySourceUpgrade(context.root, context.manifest.project.name, undefined, { accept: options.accept ?? [] });
      runtime.stdout(`Applied ${changed.length} source paths: pristine files updated, and files both you and the framework changed merged three ways. Application-only edits were kept. The framework version was not advanced; review migrations and run all checks before certification.\n`);
    });
  upgrade.command("source-finalize")
    .description("verify pristine adjacent-alpha source and run local checks before advancing its version")
    .option("--yes", "confirm local source finalization")
    .action(async (options: { yes?: boolean }, command: Command) => {
      if (!options.yes) throw new CliFailure("upgrade source-finalize requires --yes after reviewing trestle upgrade diff");
      const context = await projectContext(command, runtime);
      await finalizeSourceUpgrade(context.root, context.manifest.project.name,
        async () => { await runCommand("pnpm", ["check"], { cwd: context.root, env: process.env }); });
      runtime.stdout("Local checks passed and application source incorporates the target template; application-owned edits were kept. The source version and baseline were advanced; deployed provider readiness remains unverified.\n");
    });
  async function reportUpgradeCompatibility(root: string, json: boolean | undefined): Promise<void> {
    const report = await planUpgrade(root);
    const compatible = report.operations.every(({ classification }) => classification === "already-correct");
    runtime.stdout(json ? `${JSON.stringify(structuredOutput({ compatible, ...report }), null, 2)}\n` : compatible ? `✓ Project metadata, managed guidance, and CLI are compatible with ${report.targetVersion}\n` : formatUpgradePlan(report));
    if (!compatible) throw new CliFailure("project requires a reviewed upgrade");
  }
  upgrade.command("plan")
    .option("--json", "emit versioned structured output")
    .option("--check", "exit non-zero unless the project is already compatible")
    .action(async (options: { json?: boolean; check?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      if (options.check) { await reportUpgradeCompatibility(context.root, options.json); return; }
      const report = await planUpgrade(context.root);
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput(report), null, 2)}\n` : formatUpgradePlan(report));
    });
  upgrade.command("apply")
    .option("--yes", "confirm the reviewed upgrade plan")
    .action(async (options: { yes?: boolean }, command: Command) => {
      if (!options.yes) throw new CliFailure("upgrade apply requires --yes after reviewing trestle upgrade plan");
      const context = await projectContext(command, runtime);
      const report = await applyUpgrade(context.root);
      await runCommand("pnpm", ["install", "--lockfile-only"], { cwd: context.root, env: process.env });
      runtime.stdout(`Applied upgrade to ${report.targetVersion}\n${report.operations.filter(({ classification }) => classification === "update").map(({ id }) => `✓ ${id}`).join("\n")}\nApplication-owned source was preserved.\n`);
    });

  program
    .command("doctor")
    .description("run read-only environment and architecture checks")
    .option("--env <environment>", "environment to diagnose", environment, "local")
    .option("--json", "emit versioned structured output")
    .action(async (options: { env: ReturnType<typeof environment>; json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const report = await runDoctor(context.root, context.manifest, options.env, selectedMasterKey(runtime));
      runtime.stdout(options.json ? formatDoctorJson(report) : formatDoctorHuman(report));
      if (report.summary.failed > 0) {
        throw new CliFailure("doctor found failures");
      }
    });

  const plan = program.command("plan").description("validate and inspect a versioned SetupPlan");
  plan.command("init")
    .description("write a starter SetupPlan describing the current project")
    .action(async (_options: object, command: Command) => {
      const context = await projectContext(command, runtime);
      const file = await initSetupPlan(context.root, context.manifest);
      runtime.stdout(`Wrote ${file}\nNext: edit it, then run trestle plan diff ${file}\n`);
    });
  plan.command("validate")
    .argument("<file>", "SetupPlan JSON path or - for standard input")
    .option("--json", "emit versioned structured output")
    .action(async (file: string, options: { json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const loaded = await readSetupPlan(context.root, file, runtime);
      runtime.stdout(options.json ? formatPlanJson({ valid: true, source: loaded.source, plan: loaded.plan }) : `✓ SetupPlan schema version ${loaded.plan.schemaVersion} is valid\n✓ requires TrestleJS ${loaded.plan.minimumTrestleVersion} or newer\n✓ contains no plaintext secret values\n`);
    });
  plan.command("diff")
    .argument("<file>", "SetupPlan JSON path or - for standard input")
    .option("--json", "emit versioned structured output")
    .action(async (file: string, options: { json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const loaded = await readSetupPlan(context.root, file, runtime);
      const diff = await diffSetupPlan(context.root, context.manifest, loaded.plan, loaded.input);
      runtime.stdout(options.json ? formatPlanJson(diff) : formatPlanDiff(diff));
    });
  plan.command("status")
    .argument("[file]", "optional SetupPlan JSON path")
    .option("--json", "emit versioned structured output")
    .action(async (file: string | undefined, options: { json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const state = await readApplyState(context.root);
      const current = file ? await readSetupPlan(context.root, file, runtime) : undefined;
      const matches = current && state ? (await diffSetupPlan(context.root, context.manifest, current.plan, current.input)).planHash === state.planHash : undefined;
      const data = { state: state ?? null, ...(matches === undefined ? {} : { matchesPlan: matches }) };
      runtime.stdout(options.json ? formatPlanJson(data) : state ? `SetupPlan ${state.planHash.slice(0, 12)}\nUpdated ${state.updatedAt}\n${state.operations.map((operation) => `${operation.status === "completed" ? "✓" : "✗"} ${operation.id}${operation.reason ? ` — ${operation.reason}` : ""}`).join("\n")}\n${matches === false ? "Warning: state belongs to a different plan.\n" : ""}` : "No SetupPlan apply state exists.\n");
    });

  program.command("apply")
    .argument("<file>", "approved SetupPlan JSON path")
    .option("--yes", "confirm the reviewed mutation plan")
    .action(async (file: string, options: { yes?: boolean }, command: Command) => {
      if (!options.yes) throw new CliFailure("apply requires --yes after explicit review of the mutation plan");
      const context = await projectContext(command, runtime);
      const loaded = await readSetupPlan(context.root, file, runtime);
      const state = await applySetupPlan(context.root, context.manifest, loaded.plan, loaded.input);
      // A newly enabled platform admin adds a workspace package; refresh the lockfile so installs stay frozen.
      if (state.operations.some(({ id, status }) => id === "capabilities.admin" && status === "completed")) await runCommand("pnpm", ["install", "--lockfile-only"], { cwd: context.root, env: process.env });
      runtime.stdout(`Applied SetupPlan ${state.planHash.slice(0, 12)}\n${state.operations.map((operation) => `✓ ${operation.id}${operation.files?.length ? ` (${operation.files.length} files)` : ""}`).join("\n")}\n`);
    });

  program.command("resources")
    .description("inspect declared resources")
    .option("--json", "emit versioned structured output")
    .action(async (options: { json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const values = await inspectResources(context.root);
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput({ resources: values }), null, 2)}\n` : values.length ? `${values.map((resource) => `${resource.name}  tenant=${resource.tenant} crud=${resource.crud} table=${resource.persistence?.table ?? "none"}`).join("\n")}\n` : "No resources declared.\n");
    });
  program.command("routes")
    .description("inspect declared and statically discoverable routes")
    .option("--json", "emit versioned structured output")
    .action(async (options: { json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const values = await inspectRoutes(context.root, context.manifest);
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput({ routes: values }), null, 2)}\n` : values.length ? `${values.map((route) => `${route.method.padEnd(7)} ${route.path}  ${route.auth ? "auth" : "public"}${route.resource ? `  ${route.resource}` : ""}`).join("\n")}\n` : "No routes discovered.\n");
    });

  const resource = program.command("resource").description("evolve declared application resources with migration safety");
  resource.command("add-field")
    .argument("<resource>", "existing PascalCase resource")
    .argument("<field>", "optional field as name:type? or name:relation?:Resource:set-null")
    .option("--yes", "confirm source and migration generation")
    .action(async (resourceName: string, fieldDefinition: string, options: { yes?: boolean }, command: Command) => {
      if (!options.yes) throw new CliFailure("resource add-field requires --yes after reviewing the migration-safe optional field");
      const context = await projectContext(command, runtime);
      const field = parseResourceField(fieldDefinition);
      const changed = await addResourceField(context.root, context.manifest, resourceName, field);
      runtime.stdout(`Added ${field.name} to ${resourceName}\n${changed.map((file) => `  ${file}`).join("\n")}\n`);
    });

  resource.command("admin-read")
    .description("explicitly grant the platform admin read-only access to a tenant resource across organizations")
    .argument("<resource>", "existing PascalCase tenant resource")
    .option("--yes", "confirm the permission, RLS policy, SELECT grant, admin view, and migration")
    .action(async (resourceName: string, options: { yes?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      if (!options.yes) throw new CliFailure(`resource admin-read registers ${adminReadPermission(names(resourceName))}, adds a trestle_platform select policy and SELECT grant, and generates an audited admin view; rerun with --yes to apply`);
      const changed = await enableAdminRead(context.root, context.manifest, resourceName);
      runtime.stdout(`Granted the platform admin read access to ${resourceName}\n${changed.map((file) => `  ${file}`).join("\n")}\nNo platform role includes ${adminReadPermission(names(resourceName))} yet; add it to one in packages/authz/src/role-definitions.ts.\n`);
    });

  resource.command("migrate-relations")
    .description("move relations generated with ID-only foreign keys to tenant-safe composite keys")
    .option("--env <environment>", "environment whose database the read-only preflight checks", environment, "local")
    .option("--yes", "after a clean preflight, rewrite the schemas and generate the staged constraint migration")
    .action(async (options: { env: ReturnType<typeof environment>; yes?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const relations = await inspectResourceRelations(context.root, context.manifest);
      const legacy = relations.filter(({ state }) => state === "legacy");
      const unrecognized = relations.filter(({ state }) => state === "unrecognized");
      const describe = (relation: ResourceRelation) => `  ${relation.resource}.${relation.field} -> ${relation.parent} (${relation.table}.${relation.column}, on delete ${relation.onDelete})  ${relation.schema}`;
      if (unrecognized.length) runtime.stdout(`Relations without a recognizable foreign key (not rewritten; declare the composite key by hand):\n${unrecognized.map(describe).join("\n")}\n\n`);
      if (!legacy.length) {
        if (unrecognized.length) throw new CliFailure("no generated ID-only relations to migrate, but some relations have no composite key");
        runtime.stdout("All generated relations use tenant-safe composite keys.\n");
        return;
      }
      const preflight = relationPreflightSql(legacy);
      runtime.stdout(`ID-only relations (${legacy.length}):\n${legacy.map(describe).join("\n")}\n\nPreflight SQL (read-only; run it against every environment before applying the migration):\n${preflight}\n\n`);
      let connection: string | undefined;
      if (await access(credentialsPaths(context.root, options.env).encrypted).then(() => true, () => false)) {
        const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
        // Generated tables force RLS; the migration role is the one expected to bypass it.
        connection = values.DATABASE_MIGRATION_URL ?? values.DATABASE_URL;
      }
      if (connection) {
        const rows = await runRelationPreflight(context.root, context.manifest, connection, preflight);
        runtime.stdout(`Preflight (${options.env}):\n${rows.map((row) => `  ${row.relation}: cross-tenant=${row.cross_tenant} missing-parent=${row.missing_parents}`).join("\n")}\n`);
        const invalid = rows.filter((row) => row.cross_tenant > 0 || row.missing_parents > 0);
        if (invalid.length) {
          runtime.stdout(`\nThe composite keys would reject ${invalid.reduce((total, row) => total + row.cross_tenant + row.missing_parents, 0)} existing reference(s). Nothing was written.\nDecide which tenant owns each affected row and correct it in application-owned code or SQL (for example clear the reference or link a parent in the row's own tenant). TrestleJS never repairs, reassigns or deletes rows. Rerun this preflight until every count is 0.\n`);
          throw new CliFailure(`relation preflight found invalid rows in ${options.env}`);
        }
      } else {
        runtime.stdout(`No DATABASE_MIGRATION_URL or DATABASE_URL is configured for ${options.env}; the preflight did not run. Run it against every environment (--env) before applying the migration; VALIDATE CONSTRAINT still fails safely on invalid rows.\n`);
      }
      if (!options.yes) {
        runtime.stdout("\nDry run; nothing was written. Rerun with --yes to rewrite the schemas and generate the constraint migration.\n");
        return;
      }
      const changed = await migrateLegacyRelations(context.root, context.manifest, legacy);
      runtime.stdout(`\nMigrated ${legacy.length} relation(s) to tenant-safe composite keys:\n${changed.map((file) => `  ${file}`).join("\n")}\nReview the migration, apply it locally with trestle db migrate, and before each deployment run trestle resource migrate-relations --env <environment> to preflight that database.\n`);
    });

  const secrets = program.command("secrets").description("manage encrypted application credentials");
  secrets
    .command("init")
    .option("--env <environment>", "credentials environment", environment, "local")
    .action(async (options: { env: ReturnType<typeof environment> }, command: Command) => {
      const context = await projectContext(command, runtime);
      const result = await initializeSecrets(context.root, options.env);
      runtime.stdout(`Initialized ${options.env} credentials\n  encrypted ${result.encryptedPath}\n  key       ${result.keyPath}\n`);
    });

  secrets
    .command("import")
    .argument("<file>")
    .option("--env <environment>", "credentials environment", environment, "local")
    .action(async (file: string, options: { env: ReturnType<typeof environment> }, command: Command) => {
      const context = await projectContext(command, runtime);
      const imported = parseSecretDocument(await readFile(path.resolve(context.root, file), "utf8"));
      const declarations = context.manifest.secrets ?? {};
      for (const name of Object.keys(imported)) if (!declarations[name]) throw new CliFailure(`${name} is not declared in .trestle/project.yaml`);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      await writeSecrets(context.root, options.env, { ...values, ...imported }, selectedMasterKey(runtime));
      runtime.stdout(`Imported ${Object.keys(imported).length} credentials into ${options.env}\n`);
    });

  secrets
    .command("edit")
    .option("--env <environment>", "credentials environment", environment, "local")
    .action(async (options: { env: ReturnType<typeof environment> }, command: Command) => {
      const context = await projectContext(command, runtime);
      await editSecrets(context.root, options.env, selectedMasterKey(runtime), context.manifest);
      runtime.stdout(`Updated ${options.env} credentials\n`);
    });

  secrets
    .command("show")
    .option("--env <environment>", "credentials environment", environment, "local")
    .option("--format <format>", "yaml, json, or dotenv", "yaml")
    .action(async (options: { env: ReturnType<typeof environment>; format: string }, command: Command) => {
      if (!(["yaml", "json", "dotenv"] as const).includes(options.format as "yaml" | "json" | "dotenv")) {
        throw new InvalidArgumentError("format must be yaml, json, or dotenv");
      }
      const context = await projectContext(command, runtime);
      if (runtime.isTTY?.()) runtime.stderr("Warning: printing plaintext credentials to the terminal\n");
      runtime.stdout(reveal(await readSecrets(context.root, options.env, selectedMasterKey(runtime)), options.format as "yaml" | "json" | "dotenv"));
    });

  secrets
    .command("get")
    .argument("<name>")
    .option("--env <environment>", "credentials environment", environment, "local")
    .option("--raw", "print only the value")
    .action(async (name: string, options: { env: ReturnType<typeof environment>; raw?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const value = (await readSecrets(context.root, options.env, selectedMasterKey(runtime)))[name];
      if (value === undefined) throw new CliFailure(`${name} is not set for ${options.env}`);
      if (runtime.isTTY?.()) runtime.stderr("Warning: printing a plaintext credential to the terminal\n");
      runtime.stdout(options.raw ? value : `${name}: ${value}\n`);
    });

  secrets
    .command("list")
    .option("--env <environment>", "credentials environment", environment, "local")
    .option("--json", "emit versioned structured output")
    .action(async (options: { env: ReturnType<typeof environment>; json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      const entries = Object.entries(context.manifest.secrets ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, declaration]) => ({ name, target: declaration.target, required: declaration.required.includes(options.env), status: values[name] ? "set" : declaration.required.includes(options.env) ? "missing" : "optional" }));
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput({ environment: options.env, secrets: entries }), null, 2)}\n` : `${entries.map((entry) => `${entry.status === "set" ? "✓" : entry.status === "missing" ? "✗" : "-"} ${entry.name} (${entry.target}; ${entry.status})`).join("\n")}\n`);
    });

  secrets
    .command("check")
    .option("--env <environment>", "credentials environment", environment, "local")
    .option("--json", "emit versioned structured output")
    .action(async (options: { env: ReturnType<typeof environment>; json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const problems = validateSecrets(await readSecrets(context.root, options.env, selectedMasterKey(runtime)), context.manifest, options.env);
      if (options.json) runtime.stdout(`${JSON.stringify(structuredOutput({ environment: options.env, valid: problems.length === 0, problems }), null, 2)}\n`);
      else runtime.stdout(problems.length === 0 ? `✓ ${options.env} credentials are valid\n` : `${problems.map((problem) => `✗ ${problem}`).join("\n")}\n`);
      if (problems.length > 0) throw new CliFailure("credentials check failed");
    });

  secrets
    .command("push")
    .requiredOption("--env <environment>", "remote environment", environment)
    .option("--worker-name <name>", "override the generated Worker target for an isolated preview")
    .option("--worker-config <file>", "rendered Wrangler config in the Worker package for an isolated preview")
    .action(async (options: { env: ReturnType<typeof environment>; workerName?: string; workerConfig?: string }, command: Command) => {
      if (options.env === "local") throw new CliFailure("local credentials are injected by trestle dev and cannot be pushed remotely");
      if (options.workerName && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(options.workerName)) throw new CliFailure("worker name must be a lowercase DNS-safe name of at most 63 characters");
      if (options.workerName && options.env !== "preview") throw new CliFailure("worker name overrides are only allowed for isolated previews");
      if (Boolean(options.workerName) !== Boolean(options.workerConfig)) throw new CliFailure("isolated preview secrets require both --worker-name and --worker-config");
      if (options.workerConfig && (path.basename(options.workerConfig) !== options.workerConfig || !/^[A-Za-z0-9._-]+\.jsonc$/u.test(options.workerConfig))) throw new CliFailure("worker config must name a JSONC file in the Worker package");
      const context = await projectContext(command, runtime);
      if (options.workerConfig) {
        const workerPath = context.manifest.apps.worker;
        if (!workerPath) throw new CliFailure("project has no Worker application");
        const configSource = await readFile(path.join(context.root, workerPath, options.workerConfig), "utf8").catch(() => { throw new CliFailure("rendered preview Worker config is missing"); });
        if (wranglerStringVariable(wranglerEnvironmentBlock(configSource, "preview"), "name") !== options.workerName) throw new CliFailure("rendered preview Worker name does not match the requested isolated Worker");
      }
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      const problems = validateSecrets(values, context.manifest, options.env);
      if (problems.length > 0) throw new CliFailure(`credentials check failed:\n${problems.join("\n")}`);
      const workerValues = Object.fromEntries(Object.entries(values).filter(([name]) => context.manifest.secrets?.[name]?.target === "worker"));
      await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/worker`, "exec", "wrangler", "secret", "bulk", "--env", options.env, ...(options.workerConfig ? ["--config", options.workerConfig] : [])], { cwd: context.root, env: process.env, input: JSON.stringify(workerValues) });
      runtime.stdout(`Pushed ${Object.keys(workerValues).length} Worker secrets to ${options.env}; local encrypted credentials remain authoritative\n`);
      if (context.manifest.capabilities.admin && !options.workerName) {
        // The platform admin Worker receives only admin-targeted and explicitly shared values.
        const adminValues = adminSecretValues(values, context.manifest);
        await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/admin`, "exec", "wrangler", "secret", "bulk", "--env", options.env], { cwd: context.root, env: process.env, input: JSON.stringify(adminValues) });
        runtime.stdout(`Pushed ${Object.keys(adminValues).length} platform admin Worker secrets to ${options.env}\n`);
      }
    });

  secrets
    .command("set")
    .argument("<name>")
    .option("--env <environment>", "credentials environment", environment, "local")
    .action(async (name: string, options: { env: ReturnType<typeof environment> }, command: Command) => {
      const context = await projectContext(command, runtime);
      if (!context.manifest.secrets?.[name]) throw new CliFailure(`${name} is not declared in .trestle/project.yaml`);
      if (!runtime.stdin) throw new CliFailure("set requires a value on standard input");
      const value = (await runtime.stdin()).replace(/\r?\n$/u, "");
      if (!value) throw new CliFailure("refusing to store an empty secret");
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      values[name] = value;
      await writeSecrets(context.root, options.env, values, selectedMasterKey(runtime));
      runtime.stdout(`Set ${name} for ${options.env}\n`);
    });

  secrets
    .command("unset")
    .argument("<secret>")
    .option("--env <environment>", "credentials environment", environment, "local")
    .action(async (secret: string, options: { env: ReturnType<typeof environment> }, command: Command) => {
      const context = await projectContext(command, runtime);
      const declaration = context.manifest.secrets?.[secret];
      if (declaration?.required.includes(options.env)) throw new CliFailure(`${secret} is required for ${options.env}; update the manifest before removing it`);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      delete values[secret];
      await writeSecrets(context.root, options.env, values, selectedMasterKey(runtime));
      runtime.stdout(`Removed ${secret} from ${options.env}\n`);
    });

  const key = secrets.command("key").description("manage credentials master keys");
  key.command("rotate")
    .option("--env <environment>", "credentials environment", environment, "local")
    .action(async (options: { env: ReturnType<typeof environment> }, command: Command) => {
      const context = await projectContext(command, runtime);
      const keyPath = await rotateMasterKey(context.root, options.env, selectedMasterKey(runtime));
      runtime.stdout(`Rotated the ${options.env} master key at ${keyPath}; credential values were not rotated\n`);
    });

  const email = program.command("email").description("inspect locally captured transactional email");
  email.command("list")
    .option("--api-url <url>", "local Worker URL", "http://localhost:8787")
    .option("--json", "emit JSON")
    .action(async (options: { apiUrl: string; json?: boolean }) => {
      const messages = await listLocalEmail(options.apiUrl);
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput({ emails: messages }), null, 2)}\n` : formatEmailList(messages));
    });
  email.command("show")
    .argument("<id>")
    .option("--api-url <url>", "local Worker URL", "http://localhost:8787")
    .option("--json", "emit JSON")
    .action(async (id: string, options: { apiUrl: string; json?: boolean }) => {
      const message = await getLocalEmail(options.apiUrl, id);
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput({ email: message }), null, 2)}\n` : formatEmail(message));
    });
  email.command("open")
    .argument("<id>")
    .option("--api-url <url>", "local Worker URL", "http://localhost:8787")
    .action(async (id: string, options: { apiUrl: string }, command: Command) => {
      const context = await projectContext(command, runtime);
      await openLocalEmail(options.apiUrl, id, context.root, runtime);
    });
  email.command("clear")
    .option("--api-url <url>", "local Worker URL", "http://localhost:8787")
    .action(async (options: { apiUrl: string }) => {
      await clearLocalEmail(options.apiUrl);
      runtime.stdout("Cleared locally captured email\n");
    });
  email.command("doctor")
    .option("--env <environment>", "email environment", environment, "local")
    .action(async (options: { env: ReturnType<typeof environment> }, command: Command) => {
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime)).catch((error) => {
        if (options.env === "local" && error instanceof SecretsError) return {} as SecretValues;
        throw error;
      });
      const workerPath = context.manifest.apps.worker ?? "apps/worker";
      const config = await readFile(path.join(context.root, workerPath, "wrangler.jsonc"), "utf8");
      const block = wranglerEnvironmentBlock(config, options.env);
      const mode = options.env === "local" ? "local" : wranglerStringVariable(block, "EMAIL_DELIVERY_MODE") ?? "missing";
      const sender = wranglerStringVariable(block, "EMAIL_FROM");
      const redirect = wranglerStringVariable(block, "EMAIL_STAGING_REDIRECT");
      const redirectStatus = options.env === "local" || options.env === "production" ? "not required" : validEmailAddress(redirect) ? "configured" : "missing";
      runtime.stdout(["Email", `Environment:        ${options.env}`, `Adapter:            ${mode}`, `API key:            ${values.RESEND_API_KEY?.startsWith("re_") && values.RESEND_API_KEY.length > 3 ? "present" : mode === "local" ? "not required" : "missing"}`, `Webhook secret:     ${values.RESEND_WEBHOOK_SECRET?.startsWith("whsec_") && values.RESEND_WEBHOOK_SECRET.length > 6 ? "present" : mode === "local" ? "not required" : "missing"}`, `Sender:             ${validEmailAddress(sender) ? "configured" : mode === "local" ? "local default" : "missing"}`, `Recipient redirect: ${redirectStatus}`, ""].join("\n"));
      if (options.env === "local") { runtime.stdout("✓ Local email capture requires no provider account\n"); return; }
      const senderValue = sender && sender !== "CHANGE_ME" ? sender : undefined;
      const problems = emailDeploymentIssues({ environment: options.env as RemoteEmailEnvironment, mode: wranglerStringVariable(block, "EMAIL_DELIVERY_MODE"), apiKey: values.RESEND_API_KEY, webhookSecret: values.RESEND_WEBHOOK_SECRET, sender: senderValue, recipientRedirect: redirect });
      if (problems.length === 0 && values.RESEND_API_KEY && senderValue) {
        try { const provider = await inspectResendSender(values.RESEND_API_KEY, senderValue); if (!provider.verified) problems.push(`Resend sender domain ${provider.domain} is ${provider.providerStatus ?? "not registered"}`); }
        catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
      }
      runtime.stdout(problems.length ? `${problems.map((value) => `✗ ${value}`).join("\n")}\n` : `✓ Resend ${options.env} lifecycle and delivery safety are configured\n`);
      if (problems.length) throw new CliFailure("email doctor found failures");
    });

  const queue = experimental(program.command("queue").description("operate asynchronous delivery queues"), runtime);
  const dlq = queue.command("dlq").description("inspect dead-lettered outbox messages");
  dlq.command("list")
    .requiredOption("--env <environment>", "remote environment", environment)
    .option("--json", "emit JSON")
    .action(async (options: { env: ReturnType<typeof environment>; json?: boolean }, command: Command) => {
      if (options.env === "local") throw new CliFailure("local DLQ inspection requires a running application adapter");
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      // Outbox administration needs the migration role; remotely DATABASE_URL is the restricted runtime login.
      const connection = values.DATABASE_MIGRATION_URL ?? values.DATABASE_URL;
      if (!connection) throw new CliFailure(`DATABASE_MIGRATION_URL or DATABASE_URL is not set for ${options.env}`);
      const result = await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/db`, "exec", "tsx", "scripts/outbox-admin.ts", "list"], { cwd: context.root, env: { ...process.env, DATABASE_URL: connection }, stdio: "pipe" });
      const entries = JSON.parse(result.stdout) as unknown;
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput({ environment: options.env, entries }), null, 2)}\n` : `${(entries as Array<{ id: string; event: string; attempts: number }>).map((entry) => `${entry.id} ${entry.event} attempts=${entry.attempts}`).join("\n")}\n`);
    });
  dlq.command("redrive")
    .argument("<id>")
    .requiredOption("--env <environment>", "remote environment", environment)
    .action(async (id: string, options: { env: ReturnType<typeof environment> }, command: Command) => {
      if (options.env === "local") throw new CliFailure("local DLQ redrive requires a running application adapter");
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      // Outbox administration needs the migration role; remotely DATABASE_URL is the restricted runtime login.
      const connection = values.DATABASE_MIGRATION_URL ?? values.DATABASE_URL;
      if (!connection) throw new CliFailure(`DATABASE_MIGRATION_URL or DATABASE_URL is not set for ${options.env}`);
      const result = await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/db`, "exec", "tsx", "scripts/outbox-admin.ts", "redrive", id], { cwd: context.root, env: { ...process.env, DATABASE_URL: connection }, stdio: "pipe" });
      runtime.stdout(`Redriven ${id} in ${options.env}\n`);
      if (result.stderr) runtime.stderr(result.stderr);
    });

  queue.command("prune")
    .description("preview or prune succeeded outbox records older than an explicit UTC cutoff")
    .requiredOption("--env <environment>", "remote environment", environment)
    .requiredOption("--before <timestamp>", "exclusive ISO UTC processed-at cutoff")
    .option("--limit <count>", "maximum records to remove per run", "1000")
    .option("--apply", "perform deletion; otherwise report the eligible count")
    .action(async (options: { env: ReturnType<typeof environment>; before: string; limit: string; apply?: boolean }, command: Command) => {
      if (options.env === "local") throw new CliFailure("local outbox retention requires a running application adapter");
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(options.before) || !Number.isFinite(new Date(options.before).getTime())) throw new CliFailure("--before must be an ISO UTC timestamp");
      try { assertOutboxRetentionCutoff(options.before); } catch (error) { throw new CliFailure((error as Error).message); }
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new CliFailure("--limit must be between 1 and 10000");
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      // The retention functions run as trestle_retention and are executable only by the migration role.
      const connection = values.DATABASE_MIGRATION_URL ?? values.DATABASE_URL;
      if (!connection) throw new CliFailure(`DATABASE_MIGRATION_URL or DATABASE_URL is not set for ${options.env}`);
      const operation = options.apply ? "retention-prune" : "retention-count";
      const result = await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/db`, "exec", "tsx", "scripts/outbox-admin.ts", operation, options.before, String(limit)], { cwd: context.root, env: { ...process.env, DATABASE_URL: connection }, stdio: "pipe" });
      const summary = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as OutboxRetentionSummary;
      runtime.stdout(formatOutboxRetentionSummary({ environment: options.env, before: options.before, limit, apply: Boolean(options.apply) }, summary));
    });

  const admin = experimental(program.command("admin").description("bootstrap and manage platform admin operators"), runtime);
  const platformAdmin = async (command: Command, env: ReturnType<typeof environment>, args: string[]) => {
    const context = await projectContext(command, runtime);
    if (!context.manifest.capabilities.admin) throw new CliFailure("The platform admin is not enabled; set capabilities.admin in .trestle/setup.json and run trestle apply first");
    const values = await readSecrets(context.root, env, selectedMasterKey(runtime));
    const connection = values.DATABASE_MIGRATION_URL ?? values.DATABASE_URL;
    if (!connection) throw new CliFailure(`DATABASE_MIGRATION_URL or DATABASE_URL is not set for ${env}`);
    const result = await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/db`, "exec", "tsx", "scripts/platform-admin.ts", ...args], { cwd: context.root, env: { ...process.env, DATABASE_MIGRATION_URL: connection, TRESTLE_ENV: env }, stdio: "pipe" });
    return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as unknown;
  };
  for (const operation of ["grant", "revoke"] as const) {
    admin.command(operation)
      .description(`${operation} a platform role; the change and its reason are recorded in audit_event`)
      .argument("<email>", "the operator's account email; they must have signed up")
      .argument("<role>", "platform role key, e.g. security_admin")
      .requiredOption("--env <environment>", "target environment", environment)
      .requiredOption("--reason <reason>", "why this access is being changed")
      .action(async (email: string, role: string, options: { env: ReturnType<typeof environment>; reason: string }, command: Command) => {
        if (!options.reason.trim() || options.reason.length > 500) throw new CliFailure("--reason must be 1 to 500 characters");
        const outcome = await platformAdmin(command, options.env, [operation, email, role, options.reason]) as { correlationId: string };
        runtime.stdout(`${operation === "grant" ? "Granted" : "Revoked"} platform role ${role} ${operation === "grant" ? "to" : "from"} ${email} in ${options.env} (audit correlation ${outcome.correlationId})\n`);
      });
  }
  admin.command("list")
    .description("list active platform-role assignments")
    .requiredOption("--env <environment>", "target environment", environment)
    .action(async (options: { env: ReturnType<typeof environment> }, command: Command) => {
      const grants = await platformAdmin(command, options.env, ["list"]) as Array<{ userId: string; role: string; grantedBy: string }>;
      runtime.stdout(grants.length ? `${grants.map((grant) => `${grant.userId}\t${grant.role}\t${grant.grantedBy}`).join("\n")}\n` : "No platform-role assignments\n");
    });

  const workflow = experimental(program.command("workflow").description("inspect and retry Cloudflare Workflow instances"), runtime);
  workflow.command("list")
    .argument("<name>", "workflow name")
    .option("--env <environment>", "target environment", environment, "local")
    .option("--json", "emit provider JSON")
    .action(async (name: string, options: { env: ReturnType<typeof environment>; json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/worker`, "exec", "wrangler", ...workflowArguments("list", name, undefined, options.env, Boolean(options.json))], { cwd: context.root, env: process.env });
    });
  workflow.command("status")
    .argument("<name>", "workflow name")
    .argument("[id]", "instance ID or latest", "latest")
    .option("--env <environment>", "target environment", environment, "local")
    .option("--json", "emit provider JSON")
    .action(async (name: string, id: string, options: { env: ReturnType<typeof environment>; json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/worker`, "exec", "wrangler", ...workflowArguments("status", name, id, options.env, Boolean(options.json))], { cwd: context.root, env: process.env });
    });
  workflow.command("retry")
    .argument("<name>", "workflow name")
    .argument("<id>", "instance ID")
    .option("--env <environment>", "target environment", environment, "local")
    .option("--yes", "confirm the selected retry")
    .action(async (name: string, id: string, options: { env: ReturnType<typeof environment>; yes?: boolean }, command: Command) => {
      if (options.env !== "local" && !options.yes) throw new CliFailure("remote Workflow retry requires --yes after reviewing the instance");
      const context = await projectContext(command, runtime);
      await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/worker`, "exec", "wrangler", ...workflowArguments("retry", name, id, options.env)], { cwd: context.root, env: process.env });
    });

  const backup = experimental(program.command("backup").description("inspect and verify declared provider recovery capability"), runtime);
  backup.command("status")
    .requiredOption("--env <environment>", "protected environment", environment)
    .option("--json", "emit versioned structured output")
    .action(async (options: { env: ReturnType<typeof environment>; json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const policy = await readRecoveryPolicy(context.root);
      const childEnvironment = await recoveryEnvironment(context.root, options.env, runtime);
      const result = await runCommand("node", ["scripts/neon-recovery.mjs", "status", policy.sourceBranch], { cwd: context.root, env: childEnvironment, stdio: "pipe" });
      const provider = JSON.parse(result.stdout) as { source: { name: string }; historyRetentionSeconds: number | null; status: string; restoreVerified: false };
      const latestPath = path.join(context.root, ".trestle", "recovery-evidence", `${options.env}-latest.json`);
      const latest = await readFile(latestPath, "utf8").then((source) => JSON.parse(source) as unknown).catch(() => null);
      const data = { environment: options.env, policy, provider, latestVerification: latest };
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput(data), null, 2)}\n` : [
        `Neon recovery (${options.env})`,
        `Source branch:       ${provider.source.name}`,
        `Provider history:    ${provider.status}`,
        `Retention:           ${provider.historyRetentionSeconds === null ? "provider default/unknown" : `${provider.historyRetentionSeconds} seconds`}`,
        `Restore verified:    ${recoveryStatusLabel(latest)}`,
        `RPO objective:       ${policy.recoveryPointObjectiveHours} hours`,
        `RTO objective:       ${policy.recoveryTimeObjectiveMinutes} minutes`,
        "Provider history is not proof of a usable restore.",
        "",
      ].join("\n"));
    });

  backup.command("verify")
    .requiredOption("--env <environment>", "protected environment", environment)
    .requiredOption("--to <target>", "declared isolated restore target")
    .option("--at <timestamp>", "past ISO recovery point; defaults to latest")
    .option("--yes", "confirm isolated restore creation and cleanup")
    .option("--json", "emit versioned structured output")
    .action(async (options: { env: ReturnType<typeof environment>; to: string; at?: string; yes?: boolean; json?: boolean }, command: Command) => {
      if (!options.yes) throw new CliFailure("backup verification creates a temporary Neon branch; rerun with --yes after reviewing the target");
      const context = await projectContext(command, runtime);
      const policy = await readRecoveryPolicy(context.root);
      const target = validateRecoveryTarget(policy, options.to);
      const point = validateRecoveryPoint(options.at);
      await validateRecoveryArtifactBucket(context.root, context.manifest.apps.worker!, policy);
      const childEnvironment = await recoveryEnvironment(context.root, options.env, runtime);
      const temporary = await mkdtemp(path.join(os.tmpdir(), "trestle-recovery-"));
      const protectedOutput = path.join(temporary, "connections.env");
      const startedAt = new Date().toISOString();
      let report: { status: "passed" | "failed"; startedAt: string | null; completedAt: string; checks: Array<{ id: string; status: string; evidence: string }> } | undefined;
      let cleanup = "not-attempted";
      let created = false;
      try {
        if (!options.json) runtime.stdout(`Creating isolated Neon restore ${target} from ${policy.sourceBranch} at ${point ?? "latest"}…\n`);
        await runCommand("node", ["scripts/neon-recovery.mjs", "restore", policy.sourceBranch, target, point ?? "latest"], { cwd: context.root, env: { ...childEnvironment, TRESTLE_RECOVERY_OUTPUT: protectedOutput }, stdio: "pipe" });
        created = true;
        const connections = parseRecoveryConnectionOutput(await readFile(protectedOutput, "utf8"));
        const result = await runCommand("pnpm", ["exec", "tsx", "scripts/verify-recovery.ts"], { cwd: context.root, env: { ...childEnvironment, DATABASE_MIGRATION_URL: connections.migrationUrl, DATABASE_URL: connections.runtimeUrl, TRESTLE_VERIFY_STARTED_AT: startedAt, TRESTLE_ARTIFACT_POLICY: policy.artifactPolicy, TRESTLE_ARTIFACT_BUCKET: policy.artifactBucket ?? "" }, stdio: "pipe" });
        report = JSON.parse(result.stdout) as typeof report;
      } finally {
        try {
          if (created) {
            const result = await runCommand("node", ["scripts/neon-recovery.mjs", "delete", policy.sourceBranch, target], { cwd: context.root, env: childEnvironment, stdio: "pipe" });
            cleanup = (JSON.parse(result.stdout) as { cleanup: string }).cleanup;
          }
        } finally { await rm(temporary, { recursive: true, force: true }); }
      }
      if (!report) throw new CliFailure("recovery verification did not produce evidence");
      const durationMs = new Date(report.completedAt).getTime() - new Date(startedAt).getTime();
      const rtoMet = durationMs <= policy.recoveryTimeObjectiveMinutes * 60_000;
      const evidence = { schemaVersion: 1, environment: options.env, provider: "neon", sourceBranch: policy.sourceBranch, target, recoveryPoint: point ?? "latest", cleanup, durationMs, rtoMet, policy: { recoveryPointObjectiveHours: policy.recoveryPointObjectiveHours, recoveryTimeObjectiveMinutes: policy.recoveryTimeObjectiveMinutes, artifactPolicy: policy.artifactPolicy }, ...report, status: recoveryEvidencePassed(report, cleanup, rtoMet) ? "passed" : "failed" };
      const evidenceDirectory = path.join(context.root, ".trestle", "recovery-evidence");
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(path.join(evidenceDirectory, `${options.env}-latest.json`), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput(evidence), null, 2)}\n` : [`Recovery verification: ${evidence.status}`, `Isolated target:       ${target}`, `Cleanup:               ${cleanup}`, `Duration:              ${Math.ceil(durationMs / 1000)}s (${rtoMet ? "within" : "exceeds"} ${policy.recoveryTimeObjectiveMinutes}m RTO)`, ...report.checks.map((check) => `${check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "?"} ${check.id} — ${check.evidence}`), ""].join("\n"));
      if (evidence.status !== "passed") throw new CliFailure("recovery verification failed, remained unverifiable, exceeded RTO, or isolated cleanup was incomplete");
    });

  const restore = experimental(program.command("restore").description("create an isolated Neon point-in-time recovery branch"), runtime);
  restore.command("create")
    .requiredOption("--env <environment>", "source environment", environment)
    .requiredOption("--to <target>", "declared isolated restore target")
    .option("--at <timestamp>", "past ISO recovery point; defaults to latest")
    .option("--yes", "confirm isolated branch creation")
    .action(async (options: { env: ReturnType<typeof environment>; to: string; at?: string; yes?: boolean }, command: Command) => {
      if (!options.yes) throw new CliFailure("restore creation requires --yes after reviewing the isolated target");
      const context = await projectContext(command, runtime);
      const policy = await readRecoveryPolicy(context.root);
      const target = validateRecoveryTarget(policy, options.to);
      const point = validateRecoveryPoint(options.at);
      const childEnvironment = await recoveryEnvironment(context.root, options.env, runtime);
      const temporary = await mkdtemp(path.join(os.tmpdir(), "trestle-restore-"));
      try {
        const protectedOutput = path.join(temporary, "connections.env");
        const result = await runCommand("node", ["scripts/neon-recovery.mjs", "restore", policy.sourceBranch, target, point ?? "latest"], { cwd: context.root, env: { ...childEnvironment, TRESTLE_RECOVERY_OUTPUT: protectedOutput }, stdio: "pipe" });
        const provider = JSON.parse(result.stdout) as { branchId: string; source: string; target: string; recoveryPoint: string };
        runtime.stdout(`Created isolated Neon recovery branch ${provider.target}\nSource: ${provider.source}\nRecovery point: ${provider.recoveryPoint}\nBranch ID: ${provider.branchId}\nNo application or production binding was changed.\n`);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    });
  restore.command("delete")
    .requiredOption("--env <environment>", "source environment", environment)
    .requiredOption("--target <target>", "declared isolated restore target")
    .option("--yes", "confirm isolated branch deletion")
    .action(async (options: { env: ReturnType<typeof environment>; target: string; yes?: boolean }, command: Command) => {
      if (!options.yes) throw new CliFailure("restore deletion requires --yes");
      const context = await projectContext(command, runtime);
      const policy = await readRecoveryPolicy(context.root);
      const target = validateRecoveryTarget(policy, options.target);
      const childEnvironment = await recoveryEnvironment(context.root, options.env, runtime);
      const result = await runCommand("node", ["scripts/neon-recovery.mjs", "delete", policy.sourceBranch, target], { cwd: context.root, env: childEnvironment, stdio: "pipe" });
      const provider = JSON.parse(result.stdout) as { cleanup: string };
      runtime.stdout(`Isolated recovery target ${target}: ${provider.cleanup}\n`);
    });

  const generate = program.command("generate").description("generate application-owned source");
  generate.command("admin-module")
    .argument("<name>", "kebab-case module name, for example crop-editorial")
    .requiredOption("--permission <permission>", "existing platform permission that guards this view")
    .action(async (name: string, options: { permission: string }, command: Command) => {
      const context = await projectContext(command, runtime);
      const files = await generateAdminModule(context.root, context.manifest, name, options.permission);
      runtime.stdout(`Generated admin module ${name}\n${files.map((file) => `  ${file}`).join("\n")}\nAdd domain API routes to the admin Worker with platform authorization, step-up, and audit before enabling actions.\n`);
    });
  generate.command("email")
    .argument("<name>")
    .action(async (name: string, _options: object, command: Command) => {
      const context = await projectContext(command, runtime);
      const files = await generateEmail(context.root, name);
      runtime.stdout(`Generated ${files.join(", ")}\n`);
    });
  generate.command("resource")
    .argument("<name>")
    .option("--shared", "shared (non-tenant) reference data every tenant reads; only platform editors with platform.<plural>.manage change it in the admin")
    .option("--field <definition...>", "additional field as name:type[?] (string, text, integer, boolean, datetime, json, decimal(p,s), enum(a|b)) or name:relation:Resource[:onDelete]")
    .option("--webhook-event <kind...>", "explicitly expose created, updated, or deleted as a versioned customer webhook")
    .option("--read-permission <permission>", "application permission required to list/read", "resource.read")
    .option("--write-permission <permission>", "application permission required to create/update/delete", "resource.write")
    .option("--page-size <size>", "default cursor page size", Number, 25)
    .option("--max-page-size <size>", "maximum cursor page size", Number, 100)
    .action(async (name: string, options: { shared?: boolean; field?: string[]; webhookEvent?: string[]; readPermission: string; writePermission: string; pageSize: number; maxPageSize: number }, command: Command) => {
      const context = await projectContext(command, runtime);
      const additional = (options.field ?? []).map(parseResourceField);
      if (additional.some(({ name: fieldName }) => fieldName === "name")) throw new CliFailure("the required name:string field is generated automatically; do not redeclare it");
      if (additional.some(({ required }) => required)) throw new CliFailure("additional generated fields must initially be optional; append ? to the field type");
      const webhookEvents = options.webhookEvent ?? [];
      if (webhookEvents.some((kind) => !["created", "updated", "deleted"].includes(kind)) || new Set(webhookEvents).size !== webhookEvents.length) throw new CliFailure("--webhook-event accepts each of created, updated, and deleted at most once");
      if (!Number.isInteger(options.pageSize) || !Number.isInteger(options.maxPageSize) || options.pageSize < 1 || options.maxPageSize > 250 || options.pageSize > options.maxPageSize) throw new CliFailure("page sizes must be integers with 1 <= default <= maximum <= 250");
      if (options.shared && webhookEvents.length) throw new CliFailure("shared resources do not emit tenant webhooks; remove --webhook-event");
      if (options.shared && options.writePermission !== "resource.write") throw new CliFailure("shared resources are written only with their platform editorial permission; remove --write-permission");
      const resource = { name, tenant: !options.shared, crud: true as const, fields: [{ name: "name", type: "string", required: true } as const, ...additional], webhookEvents: webhookEvents as Array<"created" | "updated" | "deleted">, authorization: { read: options.readPermission, write: options.shared ? sharedEditorPermission(names(name)) : options.writePermission }, pagination: { defaultLimit: options.pageSize, maxLimit: options.maxPageSize } };
      const files = await generateResource(context.root, context.manifest, resource);
      files.push(...await generateResourceMigration(context.root, context.manifest, [resource]));
      runtime.stdout(`Generated ${name}\n${files.map((file) => `  ${file}`).join("\n")}\n`);
      if (options.shared) runtime.stdout(`\n${name} is shared: every tenant reads it and only ${resource.authorization.write} may change it.\nNo platform role includes that permission yet; add it to a platform role in packages/authz/src/role-definitions.ts (for example a catalog editor).\n${context.manifest.capabilities.admin ? "Editors change records in the platform admin." : "Enable the platform admin to edit records there; until then, change them through reviewed migrations or seeds."}\n`);
    });

  const payments = program.command("payments").description("manage application payments integrations");
  const stripe = payments.command("stripe").description("operate the Stripe golden-path adapter");
  stripe.command("doctor")
    .option("--env <environment>", "billing environment", environment, "local")
    .action(async (options: { env: ReturnType<typeof environment> }, command: Command) => {
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime)).catch((error) => {
        if (options.env === "local" && error instanceof SecretsError) return {} as SecretValues;
        throw error;
      });
      const workerPath = context.manifest.apps.worker ?? "apps/worker";
      const routeSource = await readFile(path.join(context.root, workerPath, "src/index.ts"), "utf8");
      const workerConfig = await readFile(path.join(context.root, workerPath, "wrangler.jsonc"), "utf8");
      const block = wranglerEnvironmentBlock(workerConfig, options.env);
      const mode = wranglerStringVariable(block, "STRIPE_MODE") ?? (options.env === "local" ? "local" : "missing");
      const catalog = validateStripeCatalog(JSON.parse(await readFile(path.join(context.root, context.manifest.packages.billing ?? "packages/billing", "stripe.json"), "utf8")) as unknown);
      const deploymentIssues = options.env === "local" ? [] : stripeDeploymentIssues(options.env, {
        mode, publishableKey: wranglerStringVariable(block, "STRIPE_PUBLISHABLE_KEY"),
        prices: wranglerStringVariable(block, "STRIPE_PRICES"), returnUrl: wranglerStringVariable(block, "BILLING_RETURN_URL"),
      }, catalog);
      runtime.stdout(["Stripe", `Environment:        ${options.env}`, `Adapter:            configured`, `Mode:               ${mode}`, `API key:            ${values.STRIPE_SECRET_KEY ? "present" : mode === "local" ? "not required" : "missing"}`, `Webhook secret:     ${values.STRIPE_WEBHOOK_SECRET ? "present (remote match unverified)" : mode === "local" ? "not required" : "missing"}`, `Webhook route:      ${routeSource.includes('/webhooks/stripe') ? "configured" : "missing"}`, `Plans:              ${Object.keys(catalog.plans).length}`, `Configuration:      ${deploymentIssues.length ? `${deploymentIssues.length} issue(s)` : "ready"}`, ""].join("\n"));
      if (options.env === "local") { runtime.stdout("✓ LocalBillingAdapter requires no Stripe account\n"); return; }
      const expected = options.env === "production" ? "live" : "test";
      const problems = [!stripeServerKeyMatchesMode(values.STRIPE_SECRET_KEY, options.env) ? `STRIPE_SECRET_KEY must be a sk_${expected}_ or rk_${expected}_ server key in ${options.env}` : "", !values.STRIPE_WEBHOOK_SECRET || !/^whsec_[A-Za-z0-9_]+$/u.test(values.STRIPE_WEBHOOK_SECRET) ? "STRIPE_WEBHOOK_SECRET must start with whsec_" : "", ...deploymentIssues].filter(Boolean);
      runtime.stdout(problems.length ? `${problems.map((value) => `✗ ${value}`).join("\n")}\n` : `✓ Stripe ${options.env} credentials and mode agree\n! Remote webhook signing-secret match requires endpoint setup and provider delivery evidence\n`);
      if (problems.length) throw new CliFailure("Stripe doctor found failures");
    });
  experimental(stripe.command("sync").description("reconcile the Stripe product and price catalog"), runtime)
    .requiredOption("--env <environment>", "remote environment", environment)
    .option("--apply", "create missing products/prices after reviewing the plan")
    .option("--yes", "confirm production provider mutation")
    .action(async (options: { env: ReturnType<typeof environment>; apply?: boolean; yes?: boolean }, command: Command) => {
      if (options.env === "local") throw new CliFailure("Stripe sync requires staging or production");
      if (options.env === "production" && options.apply && !options.yes) throw new CliFailure("production Stripe sync requires --apply --yes after review");
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      if (!values.STRIPE_SECRET_KEY) throw new CliFailure(`STRIPE_SECRET_KEY is missing for ${options.env}`);
      const catalogPath = path.join(context.root, context.manifest.packages.billing ?? "packages/billing", "stripe.json");
      const catalog = validateStripeCatalog(JSON.parse(await readFile(catalogPath, "utf8")) as unknown);
      const report = await reconcileStripeCatalog(values.STRIPE_SECRET_KEY, catalog, Boolean(options.apply));
      runtime.stdout([`Stripe sync plan (${options.env})`, ...report.items.map((item) => `${item.classification.padEnd(16)} ${item.plan}@${catalog.plans[item.plan]?.version ?? "?"}${item.reason ? ` — ${item.reason}` : ""}`), ...(Object.keys(report.prices).length ? [`STRIPE_PRICES=${JSON.stringify(report.prices)}`] : []), options.apply ? "Provider reconciliation complete." : "Review only; rerun with --apply to create missing resources.", ""].join("\n"));
      if (report.items.some((item) => item.classification === "blocked")) throw new CliFailure("Stripe sync found blocked immutable drift");
    });
  const stripeWebhook = stripe.command("webhook").description("configure a Stripe billing webhook");
  stripeWebhook.command("configure")
    .requiredOption("--env <environment>", "remote environment", environment)
    .requiredOption("--url <url>", "exact deployed /webhooks/stripe URL")
    .requiredOption("--api-key-stdin", "read a Stripe management key from standard input; never store it")
    .option("--replace-endpoint-id <id>", "explicit old endpoint to disable after encrypted secret storage")
    .option("--operation-id <id>", "stable operation ID for safe retries")
    .option("--resume", "resume an interrupted operation with the same operation ID")
    .option("--apply", "create and configure the endpoint after reviewing the plan")
    .option("--yes", "confirm production mutation")
    .action(async (options: { env: ReturnType<typeof environment>; url: string; apiKeyStdin: boolean; replaceEndpointId?: string; operationId?: string; resume?: boolean; apply?: boolean; yes?: boolean }, command: Command) => {
      if (options.env === "local") throw new CliFailure("remote Stripe webhook configuration requires preview, staging, or production");
      if (options.env === "production" && options.apply && !options.yes) throw new CliFailure("production webhook mutation requires --apply --yes after review");
      if (!options.apiKeyStdin || !runtime.stdin) throw new CliFailure("Stripe management key must be supplied on standard input");
      const apiKey = (await runtime.stdin()).trim();
      const context = await projectContext(command, runtime);
      if (!context.manifest.secrets?.STRIPE_WEBHOOK_SECRET) throw new CliFailure("STRIPE_WEBHOOK_SECRET must be declared before remote endpoint setup");
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      const report = await configureStripeWebhook({
        environment: options.env, url: options.url, apiKey, apply: Boolean(options.apply),
        ...(options.operationId ? { operationId: options.operationId } : {}),
        ...(options.replaceEndpointId ? { replaceEndpointId: options.replaceEndpointId } : {}),
        ...(options.resume ? { resume: true } : {}),
        persistSecret: async (secret) => writeSecrets(context.root, options.env, { ...values, STRIPE_WEBHOOK_SECRET: secret }, selectedMasterKey(runtime)),
      });
      runtime.stdout([`Stripe ${options.env} webhook`, `URL: ${report.url}`, `Plan: ${report.classification}`,
        `Enabled endpoint IDs: ${report.enabledEndpointIds.join(", ") || "none"}`,
        ...(report.reason ? [`Review: ${report.reason}`] : []),
        ...(report.createdEndpointId ? [`Created endpoint: ${report.createdEndpointId}`, "Signing secret stored in encrypted credentials; push secrets before testing delivery."] : []),
        ...(report.disabledEndpointId ? [`Disabled old endpoint: ${report.disabledEndpointId}`] : []), ""].join("\n"));
      if (options.apply && report.createdEndpointId) return;
      if (options.apply) throw new CliFailure("Stripe webhook setup did not apply");
    });
  experimental(stripe.command("seed").description("activate a local billing plan for an organization"), runtime)
    .requiredOption("--organization <id>", "local organization ID")
    .option("--plan <plan>", "plan to activate", "pro")
    .option("--api-url <url>", "local Worker URL", "http://localhost:8787")
    .option("--cookie-stdin", "read the local authenticated session Cookie header from standard input")
    .action(async (options: { organization: string; plan: string; apiUrl: string; cookieStdin?: boolean }) => {
      if (!options.cookieStdin || !runtime.stdin) throw new CliFailure("local billing seed requires --cookie-stdin so tenant membership is revalidated");
      const cookie = (await runtime.stdin()).trim();
      if (!cookie) throw new CliFailure("local billing seed received an empty session cookie");
      const response = await fetch(`${options.apiUrl.replace(/\/$/u, "")}/api/dev/billing`, { method: "POST", headers: { "content-type": "application/json", cookie, "x-trestle-tenant": options.organization }, body: JSON.stringify({ action: "activate", plan: options.plan }) });
      if (!response.ok) throw new CliFailure(`local billing seed failed with HTTP ${response.status}`);
      runtime.stdout(`${JSON.stringify(await response.json(), null, 2)}\n`);
    });

  program.command("logs")
    .description("tail redacted structured Worker logs")
    .requiredOption("--env <environment>", "remote environment", environment)
    .option("--worker-name <name>", "override the Worker target for an isolated preview")
    .option("--format <format>", "pretty or json", "pretty")
    .option("--status <status>", "ok, error, or canceled")
    .option("--search <text>", "filter displayed semantic event names locally")
    .option("--sampling-rate <rate>", "sample between 0 and 1", Number)
    .option("--yes", "confirm production log access")
    .action(async (options: { env: ReturnType<typeof environment>; workerName?: string; format: string; status?: string; search?: string; samplingRate?: number; yes?: boolean }, command: Command) => {
      if (options.env === "production" && !options.yes) throw new CliFailure("production log access requires --yes and is recorded by Cloudflare");
      if (options.workerName && options.env !== "preview") throw new CliFailure("worker name overrides are only allowed for isolated previews");
      if (options.format !== "pretty" && options.format !== "json") throw new CliFailure("log format must be pretty or json");
      if (options.status && !["ok", "error", "canceled"].includes(options.status)) throw new CliFailure("log status must be ok, error, or canceled");
      const context = await projectContext(command, runtime);
      const logOptions = { environment: options.env, ...(options.workerName ? { workerName: options.workerName } : {}), format: options.format as "pretty" | "json", ...(options.status ? { status: options.status as "ok" | "error" | "canceled" } : {}), ...(options.search ? { search: options.search } : {}), ...(options.samplingRate !== undefined ? { samplingRate: options.samplingRate } : {}) };
      try { buildLogTailArguments(logOptions); }
      catch (error) { throw new CliFailure(error instanceof Error ? error.message : String(error)); }
      await tailSemanticLogs(logOptions, { cwd: context.root, environment: process.env, projectName: context.manifest.project.name, output: runtime.stdout });
    });

  program
    .command("dev")
    .description("start PostgreSQL, apply migrations, and run the local applications")
    .option("--fresh", "remove only declared project-local state before startup")
    .option("--yes", "confirm the reviewed fresh-state plan")
    .option("--reclaim", "stop stale processes from this project that still hold development ports")
    .option("--takeover <port...>", "also stop the unrelated processes holding these specific ports")
    .action(async (options: { fresh?: boolean; yes?: boolean; reclaim?: boolean; takeover?: string[] }, command: Command) => {
      const context = await projectContext(command, runtime);
      const conflicts = await portConflicts(context.manifest, (port) => portOwner(port, context.root));
      if (conflicts.length) {
        const takeover = new Set((options.takeover ?? []).map(Number));
        const stoppable = conflicts.filter((conflict) => (conflict.owned && options.reclaim) || takeover.has(conflict.port));
        const blocking = conflicts.filter((conflict) => !stoppable.includes(conflict));
        if (blocking.length) {
          throw new CliFailure(`development ports are in use:\n${blocking.map((conflict) => `  ${conflict.port} (${conflict.service}): ${conflict.command} pid ${conflict.pid}${conflict.cwd ? ` in ${conflict.cwd}` : ""} — ${conflict.owned ? "from this project; rerun with --reclaim to stop it" : `not from this project; stop it yourself or pass --takeover ${conflict.port}`}`).join("\n")}`);
        }
        for (const conflict of stoppable) {
          runtime.stdout(`Stopping ${conflict.command} (pid ${conflict.pid}) on port ${conflict.port}\n`);
          try { process.kill(conflict.pid, "SIGTERM"); } catch { /* already exited */ }
        }
        for (let attempt = 0; attempt < 50 && (await portConflicts(context.manifest, (port) => portOwner(port, context.root))).some((conflict) => stoppable.some((stopped) => stopped.port === conflict.port)); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const childEnvironment = await localEnvironment(context.root, context.manifest, "local", runtime);
      const database = assertLocalDatabaseUrl(childEnvironment.DATABASE_MIGRATION_URL ?? childEnvironment.DATABASE_URL ?? "");
      const composeEnvironment = {
        ...childEnvironment,
        POSTGRES_DB: database.pathname.slice(1),
        POSTGRES_USER: decodeURIComponent(database.username),
        POSTGRES_PASSWORD: decodeURIComponent(database.password),
        TRESTLE_POSTGRES_PORT: database.port || "55432",
      };
      if (options.fresh) {
        if (!options.yes) throw new CliFailure("dev --fresh is destructive; rerun with --yes after reviewing the project-scoped state plan");
        const plan = freshDevelopmentPlan(context.root, context.manifest.apps.worker ?? "apps/worker");
        runtime.stdout(`Fresh development will remove Compose volumes declared by ${plan.composeFile}\n${plan.stateDirectories.map((target) => `Local state ${target}`).join("\n")}\n`);
        await runCommand("docker", ["compose", "down", "--volumes"], { cwd: context.root, env: composeEnvironment });
        for (const target of plan.stateDirectories) await rm(target, { recursive: true, force: true });
      }
      runtime.stdout("Starting PostgreSQL…\n");
      await runCommand("docker", ["compose", "up", "-d", "--wait"], { cwd: context.root, env: composeEnvironment });
      runtime.stdout("Applying migrations…\n");
      await runCommand("pnpm", ["db:migrate"], { cwd: context.root, env: { ...childEnvironment, DATABASE_URL: childEnvironment.DATABASE_MIGRATION_URL ?? childEnvironment.DATABASE_URL } });
      runtime.stdout("Applying deterministic development seed…\n");
      await runCommand("pnpm", ["db:seed"], { cwd: context.root, env: { ...childEnvironment, DATABASE_URL: childEnvironment.DATABASE_MIGRATION_URL ?? childEnvironment.DATABASE_URL } });
      runtime.stdout(
        `${context.manifest.apps.site ? "Site   http://localhost:42068\n" : ""}App    http://localhost:42069\nAPI    http://localhost:8787\n`,
      );
      const exitCode = await runDevelopment(context.root, childEnvironment);
      if (exitCode !== 0) throw new CliFailure(`development processes exited with status ${exitCode}`, exitCode);
    });

  const database = program.command("db").description("manage the local PostgreSQL database");
  for (const operation of ["start", "stop", "status", "migrate"] as const) {
    database.command(operation).action(async (_options: object, command: Command) => {
      const context = await projectContext(command, runtime);
      const childEnvironment = await localEnvironment(context.root, context.manifest, "local", runtime);
      const url = new URL(childEnvironment.DATABASE_MIGRATION_URL ?? childEnvironment.DATABASE_URL ?? "");
      const composeEnvironment = { ...childEnvironment, POSTGRES_DB: url.pathname.slice(1), POSTGRES_USER: decodeURIComponent(url.username), POSTGRES_PASSWORD: decodeURIComponent(url.password), TRESTLE_POSTGRES_PORT: url.port || "55432" };
      if (operation === "migrate") await runCommand("pnpm", ["db:migrate"], { cwd: context.root, env: { ...childEnvironment, DATABASE_URL: childEnvironment.DATABASE_MIGRATION_URL ?? childEnvironment.DATABASE_URL } });
      else await runCommand("docker", ["compose", ...(operation === "start" ? ["up", "-d", "--wait"] : operation === "stop" ? ["stop"] : ["ps"])], { cwd: context.root, env: composeEnvironment });
    });
  }

  database.command("seed")
    .option("--scenario <name>", "default, demo, or tenant-isolation", "default")
    .action(async (options: { scenario: string }, command: Command) => {
      if (!["default", "demo", "tenant-isolation"].includes(options.scenario)) throw new CliFailure("unknown seed scenario; expected default, demo, or tenant-isolation");
      const context = await projectContext(command, runtime);
      const childEnvironment = await localEnvironment(context.root, context.manifest, "local", runtime);
      assertLocalDatabaseUrl(childEnvironment.DATABASE_MIGRATION_URL ?? childEnvironment.DATABASE_URL ?? "");
      await runCommand("pnpm", ["exec", "tsx", "seed/index.ts", options.scenario], { cwd: context.root, env: { ...childEnvironment, APP_ENV: "local", DATABASE_URL: childEnvironment.DATABASE_MIGRATION_URL ?? childEnvironment.DATABASE_URL } });
    });

  program.command("dev-account")
    .description("create or find a verified local development account, with organization, application, and platform roles")
    .argument("<email>", "account email; an existing account is reused")
    .option("--name <name>", "display name")
    .option("--password-stdin", "read the password from standard input (required to create an account)")
    .option("--organization <slug>", "create or join this organization")
    .option("--organization-name <name>", "name for a newly created organization")
    .option("--org-role <role>", "organization role (owner, admin, member)", "owner")
    .option("--app-role <role...>", "application roles in the organization (tenant authority)")
    .option("--platform-role <role...>", "platform roles (operator authority in the platform admin)")
    .option("--json", "print the structured result")
    .action(async (email: string, options: { name?: string; passwordStdin?: boolean; organization?: string; organizationName?: string; orgRole: string; appRole?: string[]; platformRole?: string[]; json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      try {
        await access(path.join(context.root, "scripts", "dev-account.ts"));
      } catch {
        throw new CliFailure("this project has no scripts/dev-account.ts; run trestle upgrade to adopt development accounts");
      }
      const password = options.passwordStdin ? await runtime.stdin?.() : undefined;
      if (options.passwordStdin && !password) throw new CliFailure("--password-stdin requires the password on standard input");
      const childEnvironment = await localEnvironment(context.root, context.manifest, "local", runtime);
      const databaseUrl = childEnvironment.DATABASE_MIGRATION_URL ?? childEnvironment.DATABASE_URL ?? "";
      assertLocalDatabaseUrl(databaseUrl);
      const request = {
        email, ...(options.name ? { name: options.name } : {}), passwordStdin: Boolean(password),
        ...(options.organization ? { organization: { slug: options.organization, role: options.orgRole, ...(options.organizationName ? { name: options.organizationName } : {}) } } : {}),
        ...(options.appRole ? { applicationRoles: options.appRole } : {}), ...(options.platformRole ? { platformRoles: options.platformRole } : {}),
      };
      let output: string;
      try {
        output = (await runCommand("pnpm", ["exec", "tsx", "scripts/dev-account.ts"], { cwd: context.root, stdio: "pipe", ...(password ? { input: password } : {}), env: { ...childEnvironment, APP_ENV: "local", TRESTLE_ENV: "local", DATABASE_URL: databaseUrl, TRESTLE_DEV_ACCOUNT: JSON.stringify(request) } })).stdout;
      } catch (error) {
        throw new CliFailure(`development account failed: ${error instanceof Error ? error.message.split("\n").filter((line) => line && !/DeprecationWarning|trace-deprecation/u.test(line)).at(-1) ?? error.message : String(error)}`);
      }
      const result = JSON.parse(output.trim().split("\n").at(-1)!) as { userId: string; created: boolean; passwordSet: boolean; organizationId?: string; organizationCreated?: boolean; organizationRole?: string; applicationRolesGranted: string[]; platformRolesGranted: string[] };
      if (options.json) { runtime.stdout(`${JSON.stringify(structuredOutput({ account: { email, ...result } }), null, 2)}\n`); return; }
      runtime.stdout([
        `${result.created ? "Created" : "Found"} ${email} (${result.userId}), email verified${result.passwordSet ? ", password set" : ""}`,
        ...(result.organizationId ? [`Organization ${options.organization} (${result.organizationId})${result.organizationCreated ? " created" : ""}; role ${result.organizationRole}`] : []),
        `Application roles granted: ${result.applicationRolesGranted.join(", ") || "none new"}`,
        `Platform roles granted: ${result.platformRolesGranted.join(", ") || "none new"}`,
      ].join("\n") + "\n");
    });

  const databaseRoles = database.command("roles").description("manage restricted remote PostgreSQL runtime roles");
  databaseRoles.command("bootstrap")
    .requiredOption("--env <environment>", "staging or production environment", environment)
    .requiredOption("--role <name>", "restricted PostgreSQL login role")
    .option("--yes", "confirm the remote database mutation")
    .action(async (options: { env: ReturnType<typeof environment>; role: string; yes?: boolean }, command: Command) => {
      if (options.env !== "staging" && options.env !== "production") throw new CliFailure("runtime role bootstrap requires staging or production");
      if (!options.yes) throw new CliFailure("runtime role bootstrap mutates the remote database; rerun with --yes");
      const context = await projectContext(command, runtime);
      const masterKey = selectedMasterKey(runtime);
      const values = await readSecrets(context.root, options.env, masterKey);
      if (!values.DATABASE_MIGRATION_URL) throw new CliFailure(`DATABASE_MIGRATION_URL is missing for ${options.env}`);
      const directory = await mkdtemp(path.join(os.tmpdir(), "trestle-runtime-role-"));
      const output = path.join(directory, "runtime-url");
      try {
        const databasePath = context.manifest.packages.db ?? "packages/db";
        await runCommand("pnpm", ["--filter", `./${databasePath}`, "exec", "tsx", "scripts/runtime-role.ts", "bootstrap-managed"], {
          cwd: context.root,
          env: {
            ...process.env,
            DATABASE_MIGRATION_URL: values.DATABASE_MIGRATION_URL,
            DATABASE_RUNTIME_ROLE: options.role,
            TRESTLE_RUNTIME_OUTPUT: output,
          },
        });
        const result = await readFile(output, "utf8");
        const runtimeUrl = result.match(/^runtime_url=(.+)$/mu)?.[1];
        if (!runtimeUrl) throw new CliFailure("runtime role bootstrap did not produce a connection URL");
        await writeSecrets(context.root, options.env, { ...values, DATABASE_URL: runtimeUrl }, masterKey);
        runtime.stdout(`Bootstrapped restricted PostgreSQL runtime role ${options.role} for ${options.env}\nUpdated encrypted DATABASE_URL without printing it\n`);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

  database.command("console").action(async (_options: object, command: Command) => {
    const context = await projectContext(command, runtime);
    const childEnvironment = await localEnvironment(context.root, context.manifest, "local", runtime);
    const url = new URL(childEnvironment.DATABASE_MIGRATION_URL ?? childEnvironment.DATABASE_URL ?? "");
    await runCommand("psql", ["-h", url.hostname, "-p", url.port || "5432", "-U", decodeURIComponent(url.username), "-d", url.pathname.slice(1)], { cwd: context.root, env: { ...childEnvironment, PGPASSWORD: decodeURIComponent(url.password) } });
  });

  database.command("reset").option("--yes", "confirm deletion of the project-scoped local volume").action(async (options: { yes?: boolean }, command: Command) => {
    if (!options.yes) throw new CliFailure("db reset is destructive; rerun with --yes after reviewing the project-scoped Compose volume");
    const context = await projectContext(command, runtime);
    const childEnvironment = await localEnvironment(context.root, context.manifest, "local", runtime);
    const url = new URL(childEnvironment.DATABASE_MIGRATION_URL ?? childEnvironment.DATABASE_URL ?? "");
    const composeEnvironment = { ...childEnvironment, POSTGRES_DB: url.pathname.slice(1), POSTGRES_USER: decodeURIComponent(url.username), POSTGRES_PASSWORD: decodeURIComponent(url.password), TRESTLE_POSTGRES_PORT: url.port || "55432" };
    runtime.stdout(`Removing only the Compose volumes declared by ${path.join(context.root, "compose.yaml")}\n`);
    await runCommand("docker", ["compose", "down", "--volumes"], { cwd: context.root, env: composeEnvironment });
  });

  program.command("status")
    .description("report local development health: apps, APIs, database, migrations, email sink, scheduler, and providers")
    .option("--json", "print structured status")
    .action(async (options: { json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const childEnvironment = await localEnvironment(context.root, context.manifest, "local", runtime);
      const statuses = await localStatus(context.root, context.manifest, childEnvironment);
      const failed = statuses.filter((status) => status.state === "failed" || status.state === "starting");
      if (options.json) runtime.stdout(`${JSON.stringify(structuredOutput({ healthy: failed.length === 0, services: statuses }), null, 2)}\n`);
      else runtime.stdout(`${formatStatus(statuses)}\n`);
      if (failed.length) throw new CliFailure(`${failed.length} local service${failed.length === 1 ? " is" : "s are"} not healthy`, 1);
    });

  program.command("providers")
    .description("report each external provider's readiness for an environment: mode, credentials, format, and optionally a live read-only health request")
    .option("--env <environment>", "environment to check", environment, "local")
    .option("--live-check", "send each provider's declared read-only health request (never creates, buys, or sends anything)")
    .option("--json", "print structured status")
    .action(async (options: { env: ReturnType<typeof environment>; liveCheck?: boolean; json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      let secrets: Record<string, string> | { inaccessible: string };
      try {
        secrets = await readSecrets(context.root, options.env, selectedMasterKey(runtime)) as Record<string, string>;
      } catch (error) {
        secrets = { inaccessible: `cannot read ${options.env} credentials: ${error instanceof Error ? error.message : String(error)}` };
      }
      const statuses = await providerStatuses(context.manifest, options.env, secrets, { live: Boolean(options.liveCheck) });
      const blocking = statuses.filter((status) => status.mode === "live" && status.state !== "healthy");
      if (options.json) runtime.stdout(`${JSON.stringify(structuredOutput({ environment: options.env, ready: blocking.length === 0, providers: statuses }), null, 2)}\n`);
      else runtime.stdout(`${formatProviderStatuses(statuses)}\n`);
      if (blocking.length) throw new CliFailure(`${blocking.length} provider${blocking.length === 1 ? " is" : "s are"} not ready for ${options.env}`, 1);
    });

  const api = program.command("api").description("inspect the application's API contracts");
  api.command("spec")
    .description("print, write, or check the OpenAPI document generated from route policies and operation contracts")
    .option("--out <file>", "write the document to this file (for example openapi/app.json)")
    .option("--check", "with --out, fail when the file differs from the current contracts (drift detection)")
    .option("--published", "document only public and machine routes, as served outside local development")
    .option("--report", "print routes without schemas, excluded routes, and contracts without routes instead of the document")
    .action(async (options: { out?: string; check?: boolean; published?: boolean; report?: boolean }, command: Command) => {
      if (options.check && !options.out) throw new CliFailure("--check compares against a file; pass --out <file>");
      const context = await projectContext(command, runtime);
      try {
        await access(path.join(context.root, "scripts", "openapi.ts"));
      } catch {
        throw new CliFailure("this project has no scripts/openapi.ts; run trestle upgrade to adopt generated API contracts");
      }
      await runCommand("pnpm", ["exec", "tsx", "scripts/openapi.ts"], { cwd: context.root, env: { ...process.env, TRESTLE_OPENAPI_OUT: options.out ?? "", TRESTLE_OPENAPI_CHECK: options.check ? "1" : "", TRESTLE_OPENAPI_EXPOSURE: options.published ? "published" : "all", TRESTLE_OPENAPI_REPORT: options.report ? "1" : "" } });
    });

  experimental(program.command("console").description("open an application-aware TypeScript console"), runtime)
    .option("--env <environment>", "console environment", environment, "local")
    .option("--tenant <tenant>", "tenant id or slug")
    .option("--write", "allow application writes")
    .option("--platform-admin", "use separately authorized platform administration")
    .option("--yes", "confirm a non-local console")
    .action(async (options: { env: ReturnType<typeof environment>; tenant?: string; write?: boolean; platformAdmin?: boolean; yes?: boolean }, command: Command) => {
      if (options.env !== "local" && !options.yes) throw new CliFailure(`opening a ${options.env} console requires --yes`);
      if (options.tenant && options.platformAdmin) throw new CliFailure("--tenant and --platform-admin select different authority planes and cannot be combined");
      if (options.write && !options.tenant) throw new CliFailure("--write requires --tenant");
      if (!options.tenant && !options.platformAdmin) throw new CliFailure("console requires --tenant or --platform-admin");
      if (options.write && options.platformAdmin) throw new CliFailure("--write does not grant platform administration");
      const context = await projectContext(command, runtime);
      const childEnvironment = await localEnvironment(context.root, context.manifest, options.env, runtime);
      if (options.platformAdmin && !childEnvironment.DATABASE_PLATFORM_URL) throw new CliFailure("--platform-admin requires separately authorized DATABASE_PLATFORM_URL credentials");
      const operatorId = runtime.environment?.("TRESTLE_OPERATOR") ?? runtime.environment?.("USER") ?? process.env.TRESTLE_OPERATOR ?? process.env.USER ?? "unknown";
      await runCommand("pnpm", ["exec", "tsx", "scripts/console.ts"], { cwd: context.root, env: { ...childEnvironment, TRESTLE_ENV: options.env, TRESTLE_CONSOLE_OPERATOR: operatorId, TRESTLE_CONSOLE_TENANT: options.tenant ?? "", TRESTLE_CONSOLE_MODE: options.platformAdmin ? "PLATFORM ADMIN" : options.write ? "WRITE" : "READ ONLY" } });
    });

  return program;
}

export async function executeCli(arguments_: string[], runtime: CliRuntime): Promise<number> {
  try {
    await createProgram(runtime).parseAsync(["node", "trestle", ...arguments_]);
    return 0;
  } catch (error) {
    if (error instanceof CliFailure) {
      runtime.stderr(`${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    runtime.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
