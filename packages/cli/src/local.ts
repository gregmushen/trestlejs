import path from "node:path";

import type { EnvironmentName, ProjectManifest } from "@trestlejs/core";

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
  };
}
