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

export function renderQueueConfig(source, environment, workerName, capabilities = { queues: true, r2: false, workflows: false }) {
  if (!["preview", "staging", "production"].includes(environment)) throw new Error("Queue deployment requires preview, staging, or production");
  const config = JSON.parse(source);
  if (!config.env?.[environment]) throw new Error(`Wrangler environment ${environment} is not declared`);
  const target = { ...config.env[environment], name: workerName };
  if (capabilities.queues) {
    const { primary, deadLetter } = queueNames(workerName);
    target.queues = {
      producers: [{ binding: "TRESTLE_EVENTS", queue: primary }],
      consumers: [{ queue: primary, max_batch_size: 10, max_retries: 5, dead_letter_queue: deadLetter }],
    };
    target.triggers = { ...config.env[environment].triggers, crons: ["* * * * *"] };
  }
  if (capabilities.r2) target.r2_buckets = [{ binding: "TRESTLE_ARTIFACTS", bucket_name: artifactBucketName(workerName) }];
  if (capabilities.workflows) {
    target.workflows = [{ binding: "TRESTLE_WORKFLOW", name: resourceName(`${workerName}-workflow`), class_name: "TrestleWorkflow" }];
    target.vars = { ...target.vars, TRESTLE_WORKFLOWS_ENABLED: "true" };
  }
  config.env[environment] = target;
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function main() {
  const [operation, environment, workerName] = process.argv.slice(2);
  const manifest = await readFile(new URL("../.trestle/project.yaml", import.meta.url), "utf8");
  const capabilities = { queues: queuesEnabled(manifest), r2: r2Enabled(manifest), workflows: workflowsEnabled(manifest) };
  if (operation === "status") {
    process.stdout.write(`queues=${capabilities.queues} r2=${capabilities.r2} workflows=${capabilities.workflows}\n`);
    return;
  }
  if (operation !== "render" || !environment || !workerName) throw new Error("expected status or render <environment> <worker-name>");
  const source = await readFile(workerConfigUrl, "utf8");
  const output = capabilities.queues || capabilities.r2 || capabilities.workflows ? renderQueueConfig(source, environment, workerName, capabilities) : source;
  await writeFile(generatedConfigUrl, output);
  process.stdout.write(`${fileURLToPath(generatedConfigUrl)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
