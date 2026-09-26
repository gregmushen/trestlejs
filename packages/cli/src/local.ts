import path from "node:path";

import type { EnvironmentName, ProjectManifest } from "./core.js";

import type { CliRuntime } from "./runtime.js";
import { readSecrets, validateSecrets } from "./secrets.js";

export async function localEnvironment(
  root: string,
  manifest: ProjectManifest,
  environment: EnvironmentName,
  runtime: CliRuntime,
): Promise<NodeJS.ProcessEnv> {
  const key = runtime.environment?.("TRESTLE_MASTER_KEY") ?? process.env.TRESTLE_MASTER_KEY;
  const values = await readSecrets(root, environment, key);
  const problems = validateSecrets(values, manifest, environment);
  if (problems.length > 0) throw new Error(`Invalid ${environment} credentials:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  return {
    ...process.env,
    ...values,
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    TRESTLE_PROJECT_ROOT: root,
    TRESTLE_ENV: environment,
    TRESTLE_WEB_URL: values.BETTER_AUTH_URL ?? "http://localhost:42069",
    TRESTLE_WORKER_DIR: path.join(root, manifest.apps.worker ?? "apps/worker"),
    // apps/jobs (trigger.dev) reads its project and API from the manifest.
    ...(manifest.jobs?.runtime === "trigger" && manifest.jobs.project ? { TRIGGER_PROJECT_REF: manifest.jobs.project } : {}),
    ...(manifest.jobs?.runtime === "trigger" && manifest.jobs.endpoint ? { TRIGGER_API_URL: manifest.jobs.endpoint } : {}),
    // Locally, the Worker talks to the Inngest Dev Server that trestle dev runs.
    ...(manifest.jobs?.runtime === "inngest" && environment === "local" ? { INNGEST_DEV: "1", INNGEST_BASE_URL: "http://127.0.0.1:8288" } : {}),
  };
}
