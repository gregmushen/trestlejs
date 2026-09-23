import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  environmentNameSchema,
  structuredOutput,
  TRESTLEJS_VERSION,
} from "@trestlejs/core";
import { Command, CommanderError, InvalidArgumentError } from "commander";

import { formatCiValidation, validateCi } from "./ci.js";
import { checkArchitecture, formatArchitecture } from "./architecture.js";
import { parseRecoveryConnectionOutput, readRecoveryPolicy, recoveryEvidencePassed, recoveryStatusLabel, validateRecoveryPoint, validateRecoveryTarget } from "./backup.js";
import { projectContext } from "./context.js";
import { formatDoctorHuman, formatDoctorJson, runDoctor } from "./doctor.js";
import { CliFailure, type CliRuntime } from "./runtime.js";
import { localEnvironment } from "./local.js";
import { buildLogTailArguments } from "./logs.js";
import { clearLocalEmail, formatEmail, formatEmailList, getLocalEmail, listLocalEmail, openLocalEmail } from "./email.js";
import { generateEmail } from "./generate-email.js";
import { addResourceField, generateResource, generateResourceMigration, parseResourceField } from "./generate-resource.js";
import { assertLocalDatabaseUrl, freshDevelopmentPlan } from "./fresh.js";
import { formatEnvironmentStatus, inspectEnvironmentStatus } from "./environment-status.js";
import { inspectResources, inspectRoutes } from "./inspect.js";
import { applySetupPlan, diffSetupPlan, formatPlanDiff, formatPlanJson, readApplyState, readSetupPlan } from "./plan.js";
import { runCommand, runDevelopment } from "./processes.js";
import { inspectResendSender } from "./resend-status.js";
import { reconcileStripeCatalog, validateStripeCatalog } from "./stripe-sync.js";
import { wranglerEnvironmentBlock, wranglerStringVariable } from "./wrangler-config.js";
import { workflowArguments } from "./workflows.js";
import { applyUpgrade, formatUpgradePlan, planUpgrade } from "./upgrade.js";
import { loadSetupPlan, startSetupConsole } from "./setup.js";
import {
  credentialsPaths,
  editSecrets,
  formatSecretDocument,
  initializeSecrets,
  parseSecretDocument,
  readSecrets,
  rotateMasterKey,
  validateSecrets,
  writeSecrets,
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
  return { ...process.env, ...required };
}

function dotenv(values: Record<string, string>): string {
  return `${Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n")}\n`;
}

function reveal(values: Record<string, string>, format: "yaml" | "json" | "dotenv"): string {
  if (format === "json") return `${JSON.stringify(values, null, 2)}\n`;
  if (format === "dotenv") return dotenv(values);
  return formatSecretDocument(values);
}

export function createProgram(runtime: CliRuntime): Command {
  const program = new Command()
    .name("trestle")
    .description("Build and operate conventional TrestleJS applications")
    .version(TRESTLEJS_VERSION)
    .option("--cwd <path>", "start project discovery from this directory")
    .option("--no-color", "disable color output")
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
    .command("list")
    .description("list declared environments")
    .option("--json", "emit versioned structured output")
    .action(async (options: { json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      if (options.json) {
        runtime.stdout(
          `${JSON.stringify(structuredOutput({ environments: context.manifest.environments }), null, 2)}\n`,
        );
        return;
      }
      runtime.stdout(`${context.manifest.environments.join("\n")}\n`);
    });
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
  upgrade.command("plan")
    .option("--json", "emit versioned structured output")
    .action(async (options: { json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const report = await planUpgrade(context.root);
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput(report), null, 2)}\n` : formatUpgradePlan(report));
    });
  upgrade.command("check")
    .option("--json", "emit versioned structured output")
    .action(async (options: { json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const report = await planUpgrade(context.root);
      const compatible = report.operations.every(({ classification }) => classification === "already-correct");
      runtime.stdout(options.json ? `${JSON.stringify(structuredOutput({ compatible, ...report }), null, 2)}\n` : compatible ? `✓ Project metadata, managed guidance, and CLI are compatible with ${report.targetVersion}\n` : formatUpgradePlan(report));
      if (!compatible) throw new CliFailure("project requires a reviewed upgrade");
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

  program.command("setup")
    .description("review and apply a guided local SetupPlan with encrypted credentials")
    .option("--env <environment>", "credential and Doctor environment", environment, "local")
    .option("--resume", "require an existing saved SetupPlan")
    .option("--plan-only", "print the current SetupPlan diff without starting the console")
    .option("--no-open", "print the local console URL without opening a browser")
    .action(async (options: { env: ReturnType<typeof environment>; resume?: boolean; planOnly?: boolean; open: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      if (!context.manifest.environments.includes(options.env)) throw new CliFailure(`${options.env} is not declared in this project`);
      const loaded = await loadSetupPlan(context.root, context.manifest, options.resume);
      if (options.planOnly) {
        const diff = await diffSetupPlan(context.root, context.manifest, loaded.plan, loaded.input);
        runtime.stdout(formatPlanDiff(diff));
        return;
      }
      const console = await startSetupConsole(context.root, context.manifest, options.env, selectedMasterKey(runtime), options.resume);
      runtime.stdout(`Trestle setup: ${console.url}\nOne-time access code: ${console.accessCode}\nPress Ctrl+C to close.\n`);
      if (options.open) {
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
        const arguments_ = process.platform === "win32" ? ["/c", "start", "", console.url] : [console.url];
        const child = spawn(opener, arguments_, { stdio: "ignore", detached: true });
        child.on("error", () => runtime.stderr(`Open ${console.url} in a browser to continue.\n`));
        child.unref();
      }
      const stop = () => { void console.close(); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try { await console.closed; }
      finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); await console.close().catch(() => undefined); }
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

  for (const name of ["show", "export"] as const) {
    secrets
      .command(name)
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
  }

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
    .action(async (options: { env: ReturnType<typeof environment>; workerName?: string }, command: Command) => {
      if (options.env === "local") throw new CliFailure("local credentials are injected by trestle dev and cannot be pushed remotely");
      if (options.workerName && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(options.workerName)) throw new CliFailure("worker name must be a lowercase DNS-safe name of at most 63 characters");
      if (options.workerName && options.env !== "preview") throw new CliFailure("worker name overrides are only allowed for isolated previews");
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      const problems = validateSecrets(values, context.manifest, options.env);
      if (problems.length > 0) throw new CliFailure(`credentials check failed:\n${problems.join("\n")}`);
      const workerValues = Object.fromEntries(Object.entries(values).filter(([name]) => context.manifest.secrets?.[name]?.target === "worker"));
      await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/worker`, "exec", "wrangler", "secret", "bulk", "--env", options.env, ...(options.workerName ? ["--name", options.workerName] : [])], { cwd: context.root, env: process.env, input: JSON.stringify(workerValues) });
      runtime.stdout(`Pushed ${Object.keys(workerValues).length} Worker secrets to ${options.env}; local encrypted credentials remain authoritative\n`);
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

  for (const name of ["unset", "delete"] as const) {
    secrets
      .command(name)
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
  }

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
  email.command("status")
    .option("--env <environment>", "email environment", environment, "local")
    .action(async (options: { env: ReturnType<typeof environment> }, command: Command) => {
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      const workerPath = context.manifest.apps.worker ?? "apps/worker";
      const config = await readFile(path.join(context.root, workerPath, "wrangler.jsonc"), "utf8");
      const block = wranglerEnvironmentBlock(config, options.env);
      const mode = options.env === "local" ? "local" : "resend";
      const stagingProtected = options.env !== "staging" || /"EMAIL_STAGING_REDIRECT"\s*:\s*"(?!CHANGE_ME)[^"]+"/u.test(block);
      runtime.stdout(["Email", `Environment:        ${options.env}`, `Adapter:            ${mode}`, `API key:            ${values.RESEND_API_KEY ? "present" : mode === "local" ? "not required" : "missing"}`, `Webhook secret:     ${values.RESEND_WEBHOOK_SECRET ? "present" : mode === "local" ? "not required" : "missing"}`, `Sender:             ${/"EMAIL_FROM"\s*:\s*"(?!CHANGE_ME)[^"]+"/u.test(block) ? "configured" : mode === "local" ? "local default" : "missing"}`, `Staging protection: ${stagingProtected ? "configured" : "missing"}`, ""].join("\n"));
    });
  email.command("doctor")
    .option("--env <environment>", "email environment", environment, "local")
    .action(async (options: { env: ReturnType<typeof environment> }, command: Command) => {
      if (options.env === "local") { runtime.stdout("✓ Local email capture requires no provider account\n"); return; }
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      const workerPath = context.manifest.apps.worker ?? "apps/worker";
      const config = await readFile(path.join(context.root, workerPath, "wrangler.jsonc"), "utf8");
      const block = wranglerEnvironmentBlock(config, options.env);
      const senderValue = wranglerStringVariable(block, "EMAIL_FROM");
      const sender = senderValue && senderValue !== "CHANGE_ME" ? senderValue : undefined;
      const problems = [!values.RESEND_API_KEY?.startsWith("re_") ? "RESEND_API_KEY must start with re_" : "", !values.RESEND_WEBHOOK_SECRET ? "RESEND_WEBHOOK_SECRET is missing" : "", !sender ? "EMAIL_FROM is not configured" : "", options.env === "staging" && !/"EMAIL_STAGING_REDIRECT"\s*:\s*"(?!CHANGE_ME)[^"]+"/u.test(block) ? "staging recipient redirect is not configured" : ""].filter(Boolean);
      if (values.RESEND_API_KEY?.startsWith("re_") && sender) {
        try { const provider = await inspectResendSender(values.RESEND_API_KEY, sender); if (!provider.verified) problems.push(`Resend sender domain ${provider.domain} is ${provider.providerStatus ?? "not registered"}`); }
        catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
      }
      runtime.stdout(problems.length ? `${problems.map((value) => `✗ ${value}`).join("\n")}\n` : `✓ Resend ${options.env} lifecycle and delivery safety are configured\n`);
      if (problems.length) throw new CliFailure("email doctor found failures");
    });

  const queue = program.command("queue").description("operate asynchronous delivery queues");
  const dlq = queue.command("dlq").description("inspect dead-lettered outbox messages");
  dlq.command("list")
    .requiredOption("--env <environment>", "remote environment", environment)
    .option("--json", "emit JSON")
    .action(async (options: { env: ReturnType<typeof environment>; json?: boolean }, command: Command) => {
      if (options.env === "local") throw new CliFailure("local DLQ inspection requires a running application adapter");
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      if (!values.DATABASE_URL) throw new CliFailure(`DATABASE_URL is not set for ${options.env}`);
      const result = await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/db`, "exec", "tsx", "scripts/outbox-admin.ts", "list"], { cwd: context.root, env: { ...process.env, DATABASE_URL: values.DATABASE_URL }, stdio: "pipe" });
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
      if (!values.DATABASE_URL) throw new CliFailure(`DATABASE_URL is not set for ${options.env}`);
      const result = await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/db`, "exec", "tsx", "scripts/outbox-admin.ts", "redrive", id], { cwd: context.root, env: { ...process.env, DATABASE_URL: values.DATABASE_URL }, stdio: "pipe" });
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
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new CliFailure("--limit must be between 1 and 10000");
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      if (!values.DATABASE_URL) throw new CliFailure(`DATABASE_URL is not set for ${options.env}`);
      const operation = options.apply ? "retention-prune" : "retention-count";
      const result = await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/db`, "exec", "tsx", "scripts/outbox-admin.ts", operation, options.before, String(limit)], { cwd: context.root, env: { ...process.env, DATABASE_URL: values.DATABASE_URL }, stdio: "pipe" });
      const summary = JSON.parse(result.stdout) as { count: number };
      runtime.stdout(`${options.apply ? "Pruned" : "Eligible"} ${summary.count} succeeded outbox record(s) in ${options.env} before ${options.before}${options.apply ? ` (limit ${limit})` : " (dry run)"}\n`);
    });

  const workflow = program.command("workflow").description("inspect and retry Cloudflare Workflow instances");
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

  const backup = program.command("backup").description("inspect and verify declared provider recovery capability");
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
        const result = await runCommand("pnpm", ["exec", "tsx", "scripts/verify-recovery.ts"], { cwd: context.root, env: { ...childEnvironment, DATABASE_MIGRATION_URL: connections.migrationUrl, DATABASE_URL: connections.runtimeUrl, TRESTLE_VERIFY_STARTED_AT: startedAt, TRESTLE_ARTIFACT_POLICY: policy.artifactPolicy }, stdio: "pipe" });
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

  const restore = program.command("restore").description("create an isolated Neon point-in-time recovery branch");
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
  generate.command("email")
    .argument("<name>")
    .action(async (name: string, _options: object, command: Command) => {
      const context = await projectContext(command, runtime);
      const files = await generateEmail(context.root, name);
      runtime.stdout(`Generated ${files.join(", ")}\n`);
    });
  generate.command("resource")
    .argument("<name>")
    .option("--tenant", "generate organization ownership and forced RLS", true)
    .option("--no-tenant", "generate without organization ownership")
    .option("--crud", "generate CRUD contracts, routes, and UI", true)
    .option("--no-crud", "generate persistence without CRUD surfaces")
    .option("--field <definition...>", "additional field as name:type[?] or name:relation:Resource[:onDelete]")
    .option("--read-permission <permission>", "application permission required to list/read", "resource:read")
    .option("--write-permission <permission>", "application permission required to create/update/delete", "resource:write")
    .option("--page-size <size>", "default cursor page size", Number, 25)
    .option("--max-page-size <size>", "maximum cursor page size", Number, 100)
    .action(async (name: string, options: { tenant: boolean; crud: boolean; field?: string[]; readPermission: string; writePermission: string; pageSize: number; maxPageSize: number }, command: Command) => {
      const context = await projectContext(command, runtime);
      const additional = (options.field ?? []).map(parseResourceField);
      if (additional.some(({ name: fieldName }) => fieldName === "name")) throw new CliFailure("the required name:string field is generated automatically; do not redeclare it");
      if (additional.some(({ required }) => required)) throw new CliFailure("additional generated fields must initially be optional; append ? to the field type");
      if (!Number.isInteger(options.pageSize) || !Number.isInteger(options.maxPageSize) || options.pageSize < 1 || options.maxPageSize > 250 || options.pageSize > options.maxPageSize) throw new CliFailure("page sizes must be integers with 1 <= default <= maximum <= 250");
      const resource = { name, tenant: options.tenant, crud: options.crud, fields: [{ name: "name", type: "string", required: true } as const, ...additional], authorization: { read: options.readPermission, write: options.writePermission }, pagination: { defaultLimit: options.pageSize, maxLimit: options.maxPageSize } };
      const files = await generateResource(context.root, context.manifest, resource);
      files.push(...await generateResourceMigration(context.root, context.manifest, [resource]));
      runtime.stdout(`Generated ${name}\n${files.map((file) => `  ${file}`).join("\n")}\n`);
    });

  const payments = program.command("payments").description("manage application payments integrations");
  const stripe = payments.command("stripe").description("operate the Stripe golden-path adapter");
  stripe.command("init").action(async (_options: object, command: Command) => {
    const context = await projectContext(command, runtime);
    const required = ["packages/integrations/src/payments/index.ts", "packages/billing/src/index.ts", "packages/db/src/billing-schema.ts", "apps/worker/src/index.ts"];
    for (const file of required) await readFile(path.join(context.root, file), "utf8").catch(() => { throw new CliFailure(`billing scaffold is incomplete: ${file} is missing`); });
    runtime.stdout("Stripe billing\n✓ BillingService contract\n✓ Stripe adapter\n✓ Local billing adapter\n✓ subscription and entitlement projections\n✓ webhook endpoint and replay protection\n✓ Stripe configuration\nNo live Stripe resources created.\n");
  });
  stripe.command("status")
    .option("--env <environment>", "billing environment", environment, "local")
    .action(async (options: { env: ReturnType<typeof environment> }, command: Command) => {
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      const workerPath = context.manifest.apps.worker ?? "apps/worker";
      const routeSource = await readFile(path.join(context.root, workerPath, "src/index.ts"), "utf8");
      const workerConfig = await readFile(path.join(context.root, workerPath, "wrangler.jsonc"), "utf8");
      const mode = wranglerStringVariable(wranglerEnvironmentBlock(workerConfig, options.env), "STRIPE_MODE") ?? (options.env === "local" ? "local" : "missing");
      const catalog = validateStripeCatalog(JSON.parse(await readFile(path.join(context.root, context.manifest.packages.billing ?? "packages/billing", "stripe.json"), "utf8")) as unknown);
      runtime.stdout(["Stripe", `Environment:        ${options.env}`, `Adapter:            configured`, `Mode:               ${mode}`, `API key:            ${values.STRIPE_SECRET_KEY ? "present" : mode === "local" ? "not required" : "missing"}`, `Webhook secret:     ${values.STRIPE_WEBHOOK_SECRET ? "present" : mode === "local" ? "not required" : "missing"}`, `Webhook route:      ${routeSource.includes('/webhooks/stripe') ? "configured" : "missing"}`, `Plans:              ${Object.keys(catalog.plans).length}`, ""].join("\n"));
    });
  stripe.command("doctor")
    .option("--env <environment>", "billing environment", environment, "local")
    .action(async (options: { env: ReturnType<typeof environment> }, command: Command) => {
      const context = await projectContext(command, runtime);
      if (options.env === "local") { runtime.stdout("✓ LocalBillingAdapter requires no Stripe account\n"); return; }
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      const expected = options.env === "production" ? "sk_live_" : "sk_test_";
      const problems = [!values.STRIPE_SECRET_KEY?.startsWith(expected) ? `STRIPE_SECRET_KEY must use ${expected} in ${options.env}` : "", !values.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_") ? "STRIPE_WEBHOOK_SECRET must start with whsec_" : ""].filter(Boolean);
      runtime.stdout(problems.length ? `${problems.map((value) => `✗ ${value}`).join("\n")}\n` : `✓ Stripe ${options.env} credentials and mode agree\n`);
      if (problems.length) throw new CliFailure("Stripe doctor found failures");
    });
  stripe.command("sync")
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
  stripe.command("listen").action(async (_options: object, command: Command) => { const context = await projectContext(command, runtime); await runCommand("stripe", ["listen", "--forward-to", "localhost:8787/webhooks/stripe"], { cwd: context.root, env: process.env }); });
  stripe.command("webhook").action(async (_options: object, command: Command) => { const context = await projectContext(command, runtime); await runCommand("stripe", ["trigger", "customer.subscription.updated"], { cwd: context.root, env: process.env }); });
  stripe.command("seed")
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
  stripe.command("test").action(async (_options: object, command: Command) => { const context = await projectContext(command, runtime); await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/billing`, "test"], { cwd: context.root, env: process.env }); });

  program.command("logs")
    .description("tail redacted structured Worker logs")
    .requiredOption("--env <environment>", "remote environment", environment)
    .option("--worker-name <name>", "override the Worker target for an isolated preview")
    .option("--format <format>", "pretty or json", "pretty")
    .option("--status <status>", "ok, error, or canceled")
    .option("--search <text>", "search semantic event names and safe metadata")
    .option("--sampling-rate <rate>", "sample between 0 and 1", Number)
    .option("--yes", "confirm production log access")
    .action(async (options: { env: ReturnType<typeof environment>; workerName?: string; format: string; status?: string; search?: string; samplingRate?: number; yes?: boolean }, command: Command) => {
      if (options.env === "production" && !options.yes) throw new CliFailure("production log access requires --yes and is recorded by Cloudflare");
      if (options.workerName && options.env !== "preview") throw new CliFailure("worker name overrides are only allowed for isolated previews");
      if (options.format !== "pretty" && options.format !== "json") throw new CliFailure("log format must be pretty or json");
      if (options.status && !["ok", "error", "canceled"].includes(options.status)) throw new CliFailure("log status must be ok, error, or canceled");
      const context = await projectContext(command, runtime);
      let arguments_: string[];
      try { arguments_ = buildLogTailArguments({ environment: options.env, ...(options.workerName ? { workerName: options.workerName } : {}), format: options.format as "pretty" | "json", ...(options.status ? { status: options.status as "ok" | "error" | "canceled" } : {}), ...(options.search ? { search: options.search } : {}), ...(options.samplingRate !== undefined ? { samplingRate: options.samplingRate } : {}) }); }
      catch (error) { throw new CliFailure(error instanceof Error ? error.message : String(error)); }
      await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/worker`, "exec", "wrangler", ...arguments_], { cwd: context.root, env: process.env });
    });

  program
    .command("dev")
    .description("start PostgreSQL, apply migrations, and run the local applications")
    .option("--fresh", "remove only declared project-local state before startup")
    .option("--yes", "confirm the reviewed fresh-state plan")
    .action(async (options: { fresh?: boolean; yes?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
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

  program.command("console")
    .description("open an application-aware TypeScript console")
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
