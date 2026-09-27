import type { Logger } from "@__TRESTLE_PROJECT_NAME__/context";
import type { JobRuntimeOverride } from "@__TRESTLE_PROJECT_NAME__/db";
import { beforeEach, describe, expect, it } from "vitest";

import { cachedDispatchJobRuntime, dispatchJobRuntime, jobRuntimeOverrideCacheMs, registerJobRuntime, resetJobRuntimeOverrideCache } from "./job-runtime.js";
import type { WorkerEnvironment } from "./worker-environment.js";

const base = { DATABASE_URL: "postgres://user:password@127.0.0.1:1/unused", BETTER_AUTH_SECRET: "x".repeat(32), APP_ENV: "staging" } as WorkerEnvironment;
const bound = { ...base, TRESTLE_EVENTS: { send: async () => undefined } } as WorkerEnvironment;

function recordingLog() {
  const entries: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const log = {
    info: (event: string, fields?: Record<string, unknown>) => { entries.push(["info", event, fields]); },
    warn: (event: string, fields?: Record<string, unknown>) => { entries.push(["warn", event, fields]); },
    error: (event: string, fields?: Record<string, unknown>) => { entries.push(["error", event, fields]); },
  } as unknown as Logger;
  return { log, entries };
}

const override = (fields: Partial<JobRuntimeOverride>): JobRuntimeOverride => ({ runtime: null, hosting: null, endpoint: null, project: null, settings: { dispatchPaused: false }, version: 1, ...fields });

describe("dispatch runtime resolution", () => {
  beforeEach(() => resetJobRuntimeOverrideCache());

  it("uses the deployed runtime when there is no override", async () => {
    const { log } = recordingLog();
    const target = await dispatchJobRuntime(bound, log, { read: async () => null });
    expect(target).toMatchObject({ source: "declared", paused: false });
    expect(target.adapter.name).toBe("cloudflare");
  });

  it("respects an override for an installed runtime and applies its endpoint and project to the publisher", async () => {
    const seen: WorkerEnvironment[] = [];
    registerJobRuntime({ name: "trigger", publisher: (environment) => { seen.push(environment); return { send: async () => undefined }; }, describe: () => ({ configured: true, detail: "test" }) });
    const { log } = recordingLog();
    let asked = "";
    const target = await dispatchJobRuntime(bound, log, { read: async (_url, environment) => { asked = environment; return override({ runtime: "trigger", hosting: "self-hosted", endpoint: "https://jobs.example.test", project: "proj_abc" }); } });
    expect(asked).toBe("staging");
    expect(target).toMatchObject({ source: "override", paused: false });
    expect(target.adapter.name).toBe("trigger");
    expect(target.adapter.publisher(target.environment)).toBeDefined();
    expect(seen[0]).toMatchObject({ TRIGGER_API_URL: "https://jobs.example.test", TRIGGER_PROJECT_REF: "proj_abc" });
    // Vendor cloud clears a deployed self-hosted endpoint.
    resetJobRuntimeOverrideCache();
    const cloud = await dispatchJobRuntime({ ...bound, TRIGGER_API_URL: "https://old.example.test" } as WorkerEnvironment, log, { read: async () => override({ runtime: "trigger", hosting: "cloud" }) });
    expect((cloud.environment as WorkerEnvironment & { TRIGGER_API_URL?: string }).TRIGGER_API_URL).toBeUndefined();
    // Commit wake-ups use the cached target without a database read.
    expect(cachedDispatchJobRuntime(bound).adapter.name).toBe("trigger");
  });

  it("ignores and logs an override naming a runtime whose adapter is not installed, keeping any pause", async () => {
    const { log, entries } = recordingLog();
    const target = await dispatchJobRuntime(bound, log, { read: async () => override({ runtime: "inngest", hosting: "cloud", settings: { dispatchPaused: true } }) });
    expect(target.adapter.name).toBe("cloudflare");
    expect(target).toMatchObject({ source: "declared", paused: true });
    expect(entries).toContainEqual(["error", "jobs.runtime.override_ignored", { runtime: "inngest", reason: "adapter_not_installed" }]);
  });

  it("fails closed to TRESTLE_JOB_RUNTIME when the override cannot be read, and retries on the next dispatch", async () => {
    const { log, entries } = recordingLog();
    let reads = 0;
    const failing = async () => { reads += 1; throw new Error("connect ECONNREFUSED postgres://user:password@db"); };
    const target = await dispatchJobRuntime(bound, log, { read: failing });
    expect(target.adapter.name).toBe("cloudflare");
    expect(target).toMatchObject({ source: "declared", paused: false });
    expect(entries.map(([level, event]) => [level, event])).toEqual([["warn", "jobs.runtime.override_unavailable"]]);
    expect(JSON.stringify(entries)).not.toContain("password");
    await dispatchJobRuntime(bound, log, { read: failing });
    expect(reads).toBe(2);
  });

  it("reads the override at most once per 30 seconds per environment", async () => {
    const { log } = recordingLog();
    let reads = 0;
    let paused = false;
    const read = async () => { reads += 1; return override({ settings: { dispatchPaused: paused } }); };
    let now = 1_000_000;
    expect((await dispatchJobRuntime(bound, log, { read, now: () => now })).paused).toBe(false);
    paused = true;
    now += jobRuntimeOverrideCacheMs - 1;
    expect((await dispatchJobRuntime(bound, log, { read, now: () => now })).paused).toBe(false);
    expect(reads).toBe(1);
    now += 1;
    expect((await dispatchJobRuntime(bound, log, { read, now: () => now })).paused).toBe(true);
    expect(reads).toBe(2);
    // Another environment is never served from this one's cache.
    await dispatchJobRuntime({ ...bound, APP_ENV: "production" } as WorkerEnvironment, log, { read, now: () => now });
    expect(reads).toBe(3);
  });
});
