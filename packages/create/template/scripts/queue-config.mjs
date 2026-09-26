import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const workerConfigUrl = new URL("../apps/worker/wrangler.jsonc", import.meta.url);
const generatedConfigUrl = new URL("../apps/worker/.trestle-queues.wrangler.jsonc", import.meta.url);

export function queuesEnabled(manifestSource) {
  const section = manifestSource.match(/^capabilities:\s*\n((?:^[ \t]+.*\n|^\s*\n)*)/mu)?.[1];
  if (!section || !/^  queues: (?:true|false)(?:\s+#.*)?$/mu.test(section)) throw new Error("project manifest must declare capabilities.queues");
  return /^  queues: true(?:\s+#.*)?$/mu.test(section);
}

export function r2Enabled(manifestSource) {
  const section = manifestSource.match(/^capabilities:\s*\n((?:^[ \t]+.*\n|^\s*\n)*)/mu)?.[1];
  if (!section || !/^  r2: (?:true|false)(?:\s+#.*)?$/mu.test(section)) throw new Error("project manifest must declare capabilities.r2");
  return /^  r2: true(?:\s+#.*)?$/mu.test(section);
}

export function workflowsEnabled(manifestSource) {
  const section = manifestSource.match(/^capabilities:\s*\n((?:^[ \t]+.*\n|^\s*\n)*)/mu)?.[1];
  if (!section || !/^  workflows: (?:true|false)(?:\s+#.*)?$/mu.test(section)) throw new Error("project manifest must declare capabilities.workflows");
  return /^  workflows: true(?:\s+#.*)?$/mu.test(section);
}

function resourceName(value, maximum = 63) {
  if (value.length <= maximum) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${value.slice(0, maximum - digest.length - 1).replace(/-+$/u, "")}-${digest}`;
}

export function queueNames(workerName) {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(workerName)) throw new Error("invalid Worker name for Queue deployment");
  return { primary: resourceName(`${workerName}-events`), deadLetter: resourceName(`${workerName}-events-dlq`) };
}

export function artifactBucketName(workerName) {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(workerName)) throw new Error("invalid Worker name for R2 deployment");
  return resourceName(`${workerName}-artifacts`);
}

/**
 * The framework's crons, in order: a safety sweep that catches missed
 * due-time notifications, and hourly maintenance. Everything else runs when
 * due through the TrestleScheduler Durable Object, so an idle project makes
 * no database queries between sweeps. apps/worker/src/index.ts routes by the
 * same expressions.
 */
export const FRAMEWORK_SWEEP_CRON = "*/15 * * * *";
export const FRAMEWORK_MAINTENANCE_CRON = "7 * * * *";
export const FRAMEWORK_CRONS = Object.freeze([FRAMEWORK_SWEEP_CRON, FRAMEWORK_MAINTENANCE_CRON]);

/** The due-time scheduler's Durable Object binding and its additive class migration. */
export const SCHEDULER_BINDING = Object.freeze({ name: "TRESTLE_SCHEDULER", class_name: "TrestleScheduler" });
export const SCHEDULER_MIGRATION = Object.freeze({ tag: "trestle-scheduler-v1", new_sqlite_classes: Object.freeze(["TrestleScheduler"]) });

/** Keeps the application's crons in order and appends the framework crons when a capability needs them. */
function mergeCrons(declared, frameworkCrons) {
  if (declared !== undefined && (!Array.isArray(declared) || declared.some((cron) => typeof cron !== "string" || !cron.trim()))) {
    throw new Error("triggers.crons must be a list of cron expressions");
  }
  const crons = [];
  for (const cron of [...(declared ?? []), ...(frameworkCrons ? FRAMEWORK_CRONS : [])]) if (!crons.includes(cron)) crons.push(cron);
  return crons;
}

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Keeps the application's Durable Object bindings and appends the scheduler binding once. */
function mergeDurableObjects(declared) {
  if (declared !== undefined && (typeof declared !== "object" || declared === null || Array.isArray(declared) || (declared.bindings !== undefined && !Array.isArray(declared.bindings)))) {
    throw new Error("durable_objects.bindings must be a list of Durable Object bindings");
  }
  const bindings = [...(declared?.bindings ?? [])];
  const existing = bindings.find((binding) => binding?.name === SCHEDULER_BINDING.name);
  if (existing && (existing.class_name !== SCHEDULER_BINDING.class_name || existing.script_name !== undefined)) {
    throw new Error(`${SCHEDULER_BINDING.name} is reserved for the ${SCHEDULER_BINDING.class_name} Durable Object in this Worker`);
  }
  if (!existing) bindings.push({ ...SCHEDULER_BINDING });
  return { ...declared, bindings };
}

/** Durable Object migrations are append-only: keep every declared migration and append the scheduler's once. */
function mergeMigrations(declared) {
  if (declared !== undefined && (!Array.isArray(declared) || declared.some((migration) => typeof migration?.tag !== "string" || !migration.tag))) {
    throw new Error("migrations must be a list of tagged Durable Object migrations");
  }
  const migrations = [...(declared ?? [])];
  const existing = migrations.find((migration) => migration.tag === SCHEDULER_MIGRATION.tag);
  if (existing && !sameJson(existing, SCHEDULER_MIGRATION)) throw new Error(`Durable Object migration ${SCHEDULER_MIGRATION.tag} differs from the framework's; migrations must not be edited after deployment`);
  if (!existing) migrations.push({ ...SCHEDULER_MIGRATION, new_sqlite_classes: [...SCHEDULER_MIGRATION.new_sqlite_classes] });
  return migrations;
}

export function renderQueueConfig(source, environment, workerName, capabilities = { queues: true, r2: false, workflows: false }, options = {}) {
  if (!["preview", "staging", "production"].includes(environment)) throw new Error("Queue deployment requires preview, staging, or production");
  const config = JSON.parse(source);
  if (!config.env?.[environment]) throw new Error(`Wrangler environment ${environment} is not declared`);
  const target = { ...config.env[environment], name: workerName };
  if (capabilities.queues) {
    const { primary, deadLetter } = queueNames(workerName);
    target.queues = {
      producers: [{ binding: "TRESTLE_EVENTS", queue: primary }],
      consumers: [{ queue: primary, max_batch_size: 10, max_retries: 10, dead_letter_queue: deadLetter }],
    };
  }
  if (capabilities.r2) target.r2_buckets = [{ binding: "TRESTLE_ARTIFACTS", bucket_name: artifactBucketName(workerName) }];
  const frameworkWork = Boolean(capabilities.queues || capabilities.r2);
  if (frameworkWork) {
    // Every environment gets the scheduler, including cron-free previews:
    // it dispatches committed events and runs due work without any cron.
    // Durable Object bindings and migrations are not inherited from the top level.
    target.durable_objects = mergeDurableObjects(config.env[environment].durable_objects);
    target.migrations = mergeMigrations(config.env[environment].migrations ?? config.migrations);
  }
  // Ephemeral PR Workers must not consume account-wide cron capacity.
  if (environment === "preview" || options.cron === false) delete target.triggers;
  else {
    const declared = config.env[environment].triggers;
    const crons = mergeCrons(declared?.crons, frameworkWork);
    if (crons.length) target.triggers = { ...declared, crons };
  }
  if (capabilities.workflows) {
    target.workflows = [{ binding: "TRESTLE_WORKFLOW", name: resourceName(`${workerName}-workflow`), class_name: "TrestleWorkflow" }];
    target.vars = { ...target.vars, TRESTLE_WORKFLOWS_ENABLED: "true" };
  }
  config.env[environment] = target;
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function main() {
  const [operation, environment, workerName, option] = process.argv.slice(2);
  const manifest = await readFile(new URL("../.trestle/project.yaml", import.meta.url), "utf8");
  const capabilities = { queues: queuesEnabled(manifest), r2: r2Enabled(manifest), workflows: workflowsEnabled(manifest) };
  if (operation === "status") {
    process.stdout.write(`queues=${capabilities.queues} r2=${capabilities.r2} workflows=${capabilities.workflows}\n`);
    return;
  }
  if (operation !== "render" || !environment || !workerName || (option !== undefined && option !== "--without-cron")) throw new Error("expected status or render <environment> <worker-name> [--without-cron]");
  if (option === "--without-cron" && environment !== "preview") throw new Error("--without-cron is permitted only for preview deployments");
  const source = await readFile(workerConfigUrl, "utf8");
  const output = capabilities.queues || capabilities.r2 || capabilities.workflows ? renderQueueConfig(source, environment, workerName, capabilities, { cron: option !== "--without-cron" }) : source;
  await writeFile(generatedConfigUrl, output);
  process.stdout.write(`${fileURLToPath(generatedConfigUrl)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
