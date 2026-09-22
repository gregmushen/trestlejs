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

function resourceName(value, maximum = 63) {
  if (value.length <= maximum) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${value.slice(0, maximum - digest.length - 1).replace(/-+$/u, "")}-${digest}`;
}

export function queueNames(workerName) {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(workerName)) throw new Error("invalid Worker name for Queue deployment");
  return { primary: resourceName(`${workerName}-events`), deadLetter: resourceName(`${workerName}-events-dlq`) };
}

export function renderQueueConfig(source, environment, workerName) {
  if (!["preview", "staging", "production"].includes(environment)) throw new Error("Queue deployment requires preview, staging, or production");
  const { primary, deadLetter } = queueNames(workerName);
  const config = JSON.parse(source);
  if (!config.env?.[environment]) throw new Error(`Wrangler environment ${environment} is not declared`);
  config.env[environment] = {
    ...config.env[environment],
    name: workerName,
    queues: {
      producers: [{ binding: "TRESTLE_EVENTS", queue: primary }],
      consumers: [{ queue: primary, max_batch_size: 10, max_retries: 5, dead_letter_queue: deadLetter }],
    },
    triggers: { ...config.env[environment].triggers, crons: ["* * * * *"] },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function main() {
  const [operation, environment, workerName] = process.argv.slice(2);
  const enabled = queuesEnabled(await readFile(new URL("../.trestle/project.yaml", import.meta.url), "utf8"));
  if (operation === "status") {
    process.stdout.write(`enabled=${enabled}\n`);
    return;
  }
  if (operation !== "render" || !environment || !workerName) throw new Error("expected status or render <environment> <worker-name>");
  const source = await readFile(workerConfigUrl, "utf8");
  const output = enabled ? renderQueueConfig(source, environment, workerName) : source;
  await writeFile(generatedConfigUrl, output);
  process.stdout.write(`${fileURLToPath(generatedConfigUrl)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
