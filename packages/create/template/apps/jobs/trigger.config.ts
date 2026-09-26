import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@trigger.dev/sdk";
import { esbuildPlugin } from "@trigger.dev/build/extensions";
import { pythonExtension } from "@trigger.dev/python/extension";

/**
 * trigger.dev runs this project's background work (jobs.runtime: trigger).
 * Tasks run the Worker's own event consumers and scheduled jobs, so the
 * Cloudflare runtime modules the Worker imports resolve to a Node shim here.
 */
const cloudflareShim = fileURLToPath(new URL("../worker/src/cloudflare-workflow.test-shim.ts", import.meta.url));

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "set TRIGGER_PROJECT_REF",
  // The conformance task is loaded only when the runtime conformance suite runs.
  dirs: ["./src/trigger", ...(process.env.TRESTLE_JOB_CONFORMANCE === "1" ? ["./src/conformance"] : [])],
  runtime: "node",
  maxDuration: 300,
  retries: {
    enabledInDev: true,
    default: { maxAttempts: 6, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 60_000, randomize: true },
  },
  build: {
    extensions: [
      esbuildPlugin({
        name: "trestle-cloudflare-modules",
        setup(build) {
          build.onResolve({ filter: /^cloudflare:(workers|workflows)$/u }, () => ({ path: cloudflareShim }));
        },
      }),
      // Approved Python scripts (src/scripts.ts) ship only when apps/jobs/python exists.
      ...(existsSync(new URL("./python", import.meta.url)) ? [pythonExtension({ scripts: ["./python/**/*.py"], ...(existsSync(new URL("./python/requirements.txt", import.meta.url)) ? { requirementsFile: "./python/requirements.txt" } : {}), devPythonBinaryPath: process.env.TRESTLE_PYTHON ?? "python3" })] : []),
    ],
  },
});
