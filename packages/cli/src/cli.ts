import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  environmentNameSchema,
  structuredOutput,
  TRESTLEJS_VERSION,
} from "@trestlejs/core";
import { Command, CommanderError, InvalidArgumentError } from "commander";

import { projectContext } from "./context.js";
import { formatDoctorHuman, formatDoctorJson, runDoctor } from "./doctor.js";
import { CliFailure, type CliRuntime } from "./runtime.js";
import { localEnvironment } from "./local.js";
import { clearLocalEmail, formatEmail, formatEmailList, getLocalEmail, listLocalEmail, openLocalEmail } from "./email.js";
import { generateEmail } from "./generate-email.js";
import { runCommand, runDevelopment } from "./processes.js";
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
    .action(async (options: { env: ReturnType<typeof environment> }, command: Command) => {
      if (options.env === "local") throw new CliFailure("local credentials are injected by trestle dev and cannot be pushed remotely");
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      const problems = validateSecrets(values, context.manifest, options.env);
      if (problems.length > 0) throw new CliFailure(`credentials check failed:\n${problems.join("\n")}`);
      const workerValues = Object.fromEntries(Object.entries(values).filter(([name]) => context.manifest.secrets?.[name]?.target === "worker"));
      await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/worker`, "exec", "wrangler", "secret", "bulk", "--env", options.env], { cwd: context.root, env: process.env, input: JSON.stringify(workerValues) });
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

  const generate = program.command("generate").description("generate application-owned source");
  generate.command("email")
    .argument("<name>")
    .action(async (name: string, _options: object, command: Command) => {
      const context = await projectContext(command, runtime);
      const files = await generateEmail(context.root, name);
      runtime.stdout(`Generated ${files.join(", ")}\n`);
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
      const mode = options.env === "production" ? "live" : options.env === "staging" ? "test" : "local";
      const planSource = await readFile(path.join(context.root, context.manifest.packages.billing ?? "packages/billing", "src/plans.ts"), "utf8");
      const plans = [...planSource.matchAll(/^\s{2}([a-z][a-z0-9]*):/gmu)].length;
      runtime.stdout(["Stripe", `Environment:        ${options.env}`, `Adapter:            configured`, `Mode:               ${mode}`, `API key:            ${values.STRIPE_SECRET_KEY ? "present" : mode === "local" ? "not required" : "missing"}`, `Webhook secret:     ${values.STRIPE_WEBHOOK_SECRET ? "present" : mode === "local" ? "not required" : "missing"}`, `Webhook route:      ${routeSource.includes('/webhooks/stripe') ? "configured" : "missing"}`, `Plans:              ${plans}`, ""].join("\n"));
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
    .action(async (options: { env: ReturnType<typeof environment>; apply?: boolean }, command: Command) => {
      if (options.env === "local") throw new CliFailure("Stripe sync requires staging or production");
      const context = await projectContext(command, runtime);
      const values = await readSecrets(context.root, options.env, selectedMasterKey(runtime));
      if (!values.STRIPE_SECRET_KEY) throw new CliFailure(`STRIPE_SECRET_KEY is missing for ${options.env}`);
      runtime.stdout(`Stripe sync plan (${options.env})\nunknown  provider products and prices require reconciliation\n${options.apply ? "blocked  automatic creation is disabled until price currency and amount are declared\n" : "Review only; rerun with --apply after resolving blocked declarations.\n"}`);
      if (options.apply) throw new CliFailure("Stripe sync is blocked by incomplete price declarations");
    });
  stripe.command("listen").action(async (_options: object, command: Command) => { const context = await projectContext(command, runtime); await runCommand("stripe", ["listen", "--forward-to", "localhost:8787/webhooks/stripe"], { cwd: context.root, env: process.env }); });
  stripe.command("webhook").action(async (_options: object, command: Command) => { const context = await projectContext(command, runtime); await runCommand("stripe", ["trigger", "customer.subscription.updated"], { cwd: context.root, env: process.env }); });
  stripe.command("seed")
    .requiredOption("--organization <id>", "local organization ID")
    .option("--plan <plan>", "plan to activate", "pro")
    .option("--api-url <url>", "local Worker URL", "http://localhost:8787")
    .action(async (options: { organization: string; plan: string; apiUrl: string }) => {
      const response = await fetch(`${options.apiUrl.replace(/\/$/u, "")}/api/dev/billing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "activate", organizationId: options.organization, plan: options.plan }) });
      if (!response.ok) throw new CliFailure(`local billing seed failed with HTTP ${response.status}`);
      runtime.stdout(`${JSON.stringify(await response.json(), null, 2)}\n`);
    });
  stripe.command("test").action(async (_options: object, command: Command) => { const context = await projectContext(command, runtime); await runCommand("pnpm", ["--filter", `@${context.manifest.project.name}/billing`, "test"], { cwd: context.root, env: process.env }); });

  program
    .command("dev")
    .description("start PostgreSQL, apply migrations, and run the local applications")
    .action(async (_options: object, command: Command) => {
      const context = await projectContext(command, runtime);
      const childEnvironment = await localEnvironment(context.root, context.manifest, "local", runtime);
      const database = new URL(childEnvironment.DATABASE_MIGRATION_URL ?? childEnvironment.DATABASE_URL ?? "");
      const composeEnvironment = {
        ...childEnvironment,
        POSTGRES_DB: database.pathname.slice(1),
        POSTGRES_USER: decodeURIComponent(database.username),
        POSTGRES_PASSWORD: decodeURIComponent(database.password),
        TRESTLE_POSTGRES_PORT: database.port || "55432",
      };
      runtime.stdout("Starting PostgreSQL…\n");
      await runCommand("docker", ["compose", "up", "-d", "--wait"], { cwd: context.root, env: composeEnvironment });
      runtime.stdout("Applying migrations…\n");
      await runCommand("pnpm", ["db:migrate"], { cwd: context.root, env: { ...childEnvironment, DATABASE_URL: childEnvironment.DATABASE_MIGRATION_URL ?? childEnvironment.DATABASE_URL } });
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
      if (options.write && !options.tenant) throw new CliFailure("--write requires --tenant");
      const context = await projectContext(command, runtime);
      const childEnvironment = await localEnvironment(context.root, context.manifest, options.env, runtime);
      await runCommand("pnpm", ["exec", "tsx", "scripts/console.ts"], { cwd: context.root, env: { ...childEnvironment, TRESTLE_CONSOLE_TENANT: options.tenant ?? "", TRESTLE_CONSOLE_MODE: options.platformAdmin ? "PLATFORM ADMIN" : options.write ? "WRITE" : "READ ONLY" } });
    });

  return program;
}

export async function executeCli(arguments_: string[], runtime: CliRuntime): Promise<number> {
  try {
    await createProgram(runtime).parseAsync(["node", "trestle", ...arguments_]);
    return 0;
  } catch (error) {
    if (error instanceof CliFailure) {
      return error.exitCode;
    }
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    runtime.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
