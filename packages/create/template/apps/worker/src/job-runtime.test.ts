import { describe, expect, it } from "vitest";

import { cloudflareRuntime, jobRuntime, registerJobRuntime } from "./job-runtime.js";
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
