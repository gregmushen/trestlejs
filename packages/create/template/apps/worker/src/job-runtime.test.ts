import { describe, expect, it } from "vitest";

import { cloudflareRuntime, declaredJobRuntime, declareJobRuntime, jobRuntime, registerJobRuntime, resetJobRuntimeDeclaration } from "./job-runtime.js";
import type { WorkerEnvironment } from "./worker-environment.js";

const base = { DATABASE_URL: "postgres://user:password@127.0.0.1:1/unused", BETTER_AUTH_SECRET: "x".repeat(32) } as WorkerEnvironment;

describe("job runtime selection", () => {
  it("defaults to Cloudflare, which dispatches only when its Queue is bound", async () => {
    expect(jobRuntime(base)).toBe(cloudflareRuntime);
    expect(cloudflareRuntime.publisher(base)).toBeUndefined();
    expect(cloudflareRuntime.describe(base)).toMatchObject({ configured: false });
    const sent: unknown[] = [];
    const bound = { ...base, TRESTLE_EVENTS: { send: async (body: unknown) => { sent.push(body); } } } as WorkerEnvironment;
    expect(cloudflareRuntime.describe(bound)).toEqual({ configured: true, detail: "Cloudflare Queues" });
    expect(cloudflareRuntime.publisher(bound)).toBeDefined();
  });

  it("fails closed for unknown or uninstalled runtimes", () => {
    expect(() => jobRuntime({ ...base, TRESTLE_JOB_RUNTIME: "celery" })).toThrow("Unknown job runtime celery");
    expect(() => jobRuntime({ ...base, TRESTLE_JOB_RUNTIME: "inngest" })).toThrow("adapter is not installed");
    registerJobRuntime({ name: "inngest", publisher: () => undefined, describe: () => ({ configured: false, detail: "test" }) });
    expect(jobRuntime({ ...base, TRESTLE_JOB_RUNTIME: "inngest" }).name).toBe("inngest");
  });
});

describe("declared job runtime", () => {
  it("derives hosting from the configured endpoint and never records secrets or unsafe URLs", () => {
    for (const name of ["trigger", "inngest"] as const) registerJobRuntime({ name, publisher: () => undefined, describe: () => ({ configured: false, detail: "test" }) });
    expect(declaredJobRuntime(base)).toEqual({ runtime: "cloudflare", hosting: "cloudflare", endpoint: null, project: null, available: ["cloudflare", "inngest", "trigger"], credentials: { INNGEST_EVENT_KEY: false, INNGEST_SIGNING_KEY: false, RESEND_API_KEY: false, TRIGGER_SECRET_KEY: false } });
    const trigger = { ...base, TRESTLE_JOB_RUNTIME: "trigger", TRIGGER_SECRET_KEY: "tr_prod_secret", TRIGGER_PROJECT_REF: "proj_abc" } as WorkerEnvironment;
    expect(declaredJobRuntime(trigger)).toMatchObject({ runtime: "trigger", hosting: "cloud", endpoint: null, project: "proj_abc" });
    expect(declaredJobRuntime({ ...trigger, TRIGGER_API_URL: "https://api.trigger.dev" } as WorkerEnvironment)).toMatchObject({ hosting: "cloud", endpoint: null });
    expect(declaredJobRuntime({ ...trigger, TRIGGER_API_URL: "https://user:pass@jobs.example.com/?token=x" } as WorkerEnvironment)).toMatchObject({ hosting: "self-hosted", endpoint: "https://jobs.example.com" });
    expect(declaredJobRuntime({ ...trigger, TRIGGER_API_URL: "javascript:alert(1)" } as WorkerEnvironment)).toMatchObject({ hosting: "cloud", endpoint: null });
    expect(JSON.stringify(declaredJobRuntime(trigger))).not.toContain("tr_prod_secret");
    // Presence only: the admin shows set or missing.
    expect(declaredJobRuntime(trigger).credentials).toEqual({ INNGEST_EVENT_KEY: false, INNGEST_SIGNING_KEY: false, RESEND_API_KEY: false, TRIGGER_SECRET_KEY: true });
    const inngest = { ...base, TRESTLE_JOB_RUNTIME: "inngest", INNGEST_EVENT_KEY: "event-key-secret" } as WorkerEnvironment;
    expect(declaredJobRuntime(inngest)).toMatchObject({ runtime: "inngest", hosting: "cloud", endpoint: null, project: null });
    expect(declaredJobRuntime({ ...inngest, INNGEST_BASE_URL: "http://inngest.internal:8288/" } as WorkerEnvironment)).toMatchObject({ runtime: "inngest", hosting: "self-hosted", endpoint: "http://inngest.internal:8288", project: null });
  });

  it("records the declaration once per change, not on every sweep", async () => {
    resetJobRuntimeDeclaration();
    const writes: Array<[string, unknown]> = [];
    const record = async (_url: string, environment: string, declared: unknown) => { writes.push([environment, declared]); return true; };
    const staging = { ...base, APP_ENV: "staging" } as WorkerEnvironment;
    expect(await declareJobRuntime(staging, record)).toBe(true);
    expect(await declareJobRuntime(staging, record)).toBe(false);
    expect(writes).toEqual([["staging", { runtime: "cloudflare", hosting: "cloudflare", endpoint: null, project: null, available: ["cloudflare", "inngest", "trigger"], credentials: { INNGEST_EVENT_KEY: false, INNGEST_SIGNING_KEY: false, RESEND_API_KEY: false, TRIGGER_SECRET_KEY: false } }]]);
    await declareJobRuntime({ ...staging, TRESTLE_JOB_RUNTIME: "inngest", INNGEST_BASE_URL: "https://inngest.example.com" } as WorkerEnvironment, record);
    expect(writes).toHaveLength(2);
    resetJobRuntimeDeclaration();
    await expect(declareJobRuntime(staging, async () => { throw new Error("database down"); })).rejects.toThrow("database down");
    // A failed record is retried on the next sweep.
    expect(await declareJobRuntime(staging, record)).toBe(true);
  });
});
