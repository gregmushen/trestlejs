import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runtimeConformanceSuite, type ConformanceHarness } from "./job-conformance-suite.js";
import { PostgresOutboxStore } from "@__TRESTLE_PROJECT_NAME__/db";
import { dispatchOutbox } from "@__TRESTLE_PROJECT_NAME__/events";

import { triggerCommittedEvent } from "./job-runtime-trigger.js";

/**
 * The conformance suite against a real trigger.dev engine (hosted or
 * self-hosted): the harness runs `trigger dev` for apps/jobs with the
 * conformance task, triggers runs through the same REST call the Worker's
 * publisher makes, and reads run status from the trigger.dev API.
 *
 * Needs TRESTLE_TRIGGER_API_URL, TRESTLE_TRIGGER_SECRET_KEY (the project's dev
 * environment key), TRESTLE_TRIGGER_PROJECT_REF, and TRIGGER_ACCESS_TOKEN.
 */
const apiUrl = process.env.TRESTLE_TRIGGER_API_URL;
const secretKey = process.env.TRESTLE_TRIGGER_SECRET_KEY;
const projectRef = process.env.TRESTLE_TRIGGER_PROJECT_REF;
const jobsDirectory = fileURLToPath(new URL("../../jobs/", import.meta.url));
const versionFile = path.join(jobsDirectory, "src", "conformance", "version.ts");
const terminal = new Set(["COMPLETED", "FAILED", "CRASHED", "SYSTEM_FAILURE", "CANCELED", "EXPIRED", "TIMED_OUT"]);
const failures = new Set(["FAILED", "CRASHED", "SYSTEM_FAILURE", "CANCELED", "EXPIRED", "TIMED_OUT"]);

async function runStatus(runId: string): Promise<string> {
  const response = await fetch(`${apiUrl!.replace(/\/$/u, "")}/api/v3/runs/${runId}`, { headers: { authorization: `Bearer ${secretKey}` } });
  if (!response.ok) throw new Error(`run status HTTP ${response.status}`);
  return (await response.json() as { status: string }).status;
}

async function triggerHarness(connectionString: string): Promise<ConformanceHarness> {
  const runs = new Map<string, string>();
  let child: ChildProcess | undefined;
  let output = "";
  const ready = async (after: number) => {
    for (let waited = 0; waited < 180_000; waited += 500) {
      const readyLines = output.slice(after).match(/Local worker ready/gu);
      if (readyLines) return;
      if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`trigger dev exited: ${output.slice(-2_000)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`trigger dev was not ready: ${output.slice(-2_000)}`);
  };
  const start = async () => {
    const from = output.length;
    child = spawn("pnpm", ["exec", "trigger", "dev", "--skip-update-check"], {
      cwd: jobsDirectory, stdio: ["ignore", "pipe", "pipe"], detached: true,
      env: { ...process.env, TRIGGER_API_URL: apiUrl, TRIGGER_PROJECT_REF: projectRef, TRESTLE_JOB_CONFORMANCE: "1", TRESTLE_CONFORMANCE_DATABASE_URL: connectionString },
    });
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString().replace(/\x1b\[[0-9;]*m/gu, ""); });
    child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString().replace(/\x1b\[[0-9;]*m/gu, ""); });
    await ready(from);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
    await exited;
  };
  await writeFile(versionFile, 'export const conformanceVersion = "v1";\n');
  await start();
  const publisher: ConformanceHarness["publisher"] = {
    send: async (envelope, delivery) => {
      const { runId } = await triggerCommittedEvent({ apiUrl: apiUrl!, secretKey: secretKey!, taskId: "trestle-conformance-event", eventId: envelope.id, generation: delivery?.generation ?? 0 });
      runs.set(envelope.id, runId);
    },
  };
  return {
    runtime: "trigger",
    publisher,
    async settle() {
      const settledRuns = async () => {
        for (let waited = 0; waited < 180_000; waited += 1_000) {
          const statuses = await Promise.all([...runs.values()].map(runStatus));
          if (statuses.every((status) => terminal.has(status))) return;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        throw new Error("trigger.dev runs did not settle");
      };
      await settledRuns();
      // The Worker's settlement sweep, with no grace period because every run has ended.
      const store = new PostgresOutboxStore(connectionString);
      try {
        for (let round = 0; round < 3 && (await store.settleUnconsumed({ olderThanMs: 0 })).length > 0; round++) {
          await dispatchOutbox(store, publisher);
          await settledRuns();
        }
      } finally { await store.close(); }
    },
    async failed() {
      const failed: string[] = [];
      for (const [eventId, runId] of runs) if (failures.has(await runStatus(runId))) failed.push(eventId);
      return failed;
    },
    async deploy(version) {
      const from = output.length;
      await writeFile(versionFile, `export const conformanceVersion = ${JSON.stringify(version)};\n`);
      await ready(from);
    },
    async restart() { await stop(); await start(); },
    async close() {
      await stop();
      if ((await readFile(versionFile, "utf8")).includes('"v1"') === false) await writeFile(versionFile, 'export const conformanceVersion = "v1";\n');
    },
  };
}

runtimeConformanceSuite({
  runtime: "trigger",
  connectionString: apiUrl && secretKey && projectRef ? process.env.TRESTLE_RLS_TEST_DATABASE_URL : undefined,
  harness: triggerHarness,
  deploy: "pinned",
  timeoutMs: 180_000,
});
