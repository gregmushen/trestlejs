import { describe, expect, it } from "vitest";

import type { ProjectManifest } from "../src/core.js";
import { projectManifestSchema } from "../src/manifest.js";
import { formatProviderStatuses, providerStatuses } from "../src/providers.js";

const manifest = projectManifestSchema.parse({
  schemaVersion: 1, project: { name: "fixture" }, apps: {}, packages: {},
  tenancy: { model: "organization", enforcement: "postgres-rls" }, database: { engine: "postgresql", defaultProvider: "neon" },
  capabilities: { r2: false, queues: false, workflows: false, durableObjects: false, admin: false }, environments: ["local", "staging"],
  providers: {
    geocoder: {
      description: "Address geocoding", secrets: ["GEOCODER_API_KEY"], mode: { local: "fixture", staging: "live" },
      patterns: { GEOCODER_API_KEY: "^geo_" }, setup: "Create a key, then: trestle secrets set GEOCODER_API_KEY --env <environment>",
      health: { url: "https://geocoder.example/v1/status", bearer: "GEOCODER_API_KEY" },
    },
  },
}) as ProjectManifest;

const byId = (statuses: Awaited<ReturnType<typeof providerStatuses>>) => Object.fromEntries(statuses.map((status) => [status.id, status]));

describe("provider readiness", () => {
  it("uses fixtures locally without credentials", async () => {
    const statuses = byId(await providerStatuses(manifest, "local", {}));
    expect(statuses.geocoder).toMatchObject({ mode: "fixture", state: "fixture" });
    expect(statuses.resend).toMatchObject({ mode: "fixture", state: "fixture" });
  });

  it("distinguishes missing, malformed, inaccessible, and present credentials without printing values", async () => {
    const missing = byId(await providerStatuses(manifest, "staging", {}));
    expect(missing.geocoder).toMatchObject({ state: "unconfigured", detail: "missing GEOCODER_API_KEY", repair: expect.stringContaining("--env staging") });
    const malformed = byId(await providerStatuses(manifest, "staging", { GEOCODER_API_KEY: "sk-secret-value" }));
    expect(malformed.geocoder).toMatchObject({ state: "invalid" });
    expect(JSON.stringify(malformed)).not.toContain("sk-secret-value");
    const inaccessible = byId(await providerStatuses(manifest, "staging", { inaccessible: "no key" }));
    expect(inaccessible.geocoder).toMatchObject({ state: "inaccessible", repair: expect.stringContaining("TRESTLE_MASTER_KEY") });
    const present = byId(await providerStatuses(manifest, "staging", { GEOCODER_API_KEY: "geo_123" }));
    expect(present.geocoder).toMatchObject({ state: "healthy", checkedLive: false, detail: expect.stringContaining("--live-check") });
  });

  it("sends a live read-only health request only when asked, with the secret as a bearer token", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const probe = async (url: string, headers: Record<string, string>) => { requests.push({ url, headers }); return url.includes("geocoder") ? { status: 401 } : { status: 200 }; };
    await providerStatuses(manifest, "staging", { GEOCODER_API_KEY: "geo_123" }, { probe });
    expect(requests).toEqual([]);
    const live = byId(await providerStatuses(manifest, "staging", { GEOCODER_API_KEY: "geo_123" }, { live: true, probe }));
    expect(live.geocoder).toMatchObject({ state: "invalid", checkedLive: true, detail: expect.stringContaining("401") });
    expect(requests.find((request) => request.url.includes("geocoder"))?.headers.authorization).toBe("Bearer geo_123");
    const unreachable = byId(await providerStatuses(manifest, "staging", { GEOCODER_API_KEY: "geo_123" }, { live: true, probe: async () => ({ error: "TimeoutError" }) }));
    expect(unreachable.geocoder).toMatchObject({ state: "inaccessible" });
  });

  it("keeps human output consistent with the structured status", async () => {
    const statuses = await providerStatuses(manifest, "staging", {});
    const text = formatProviderStatuses(statuses);
    for (const status of statuses) expect(text).toContain(`${status.mode.padEnd(8)}  ${status.state}`);
  });

  it("rejects health checks that are not https", () => {
    expect(() => projectManifestSchema.parse({ ...manifest, providers: { bad: { description: "x", setup: "y", health: { url: "http://example.test" } } } })).toThrow("https");
  });
});

describe("jobs declaration", () => {
  const withJobs = (jobs: unknown) => projectManifestSchema.safeParse({ ...manifest, jobs });
  it("accepts the default, hosted, and self-hosted runtimes and rejects inconsistent settings", () => {
    expect(withJobs({}).success).toBe(true);
    expect(withJobs({ runtime: "trigger" }).success).toBe(true);
    expect(withJobs({ runtime: "inngest", hosting: "self-hosted", endpoint: "https://inngest.example.com" }).success).toBe(true);
    expect(withJobs({ runtime: "trigger", hosting: "self-hosted", endpoint: "http://localhost:3040" }).success).toBe(true);
    expect(withJobs({ runtime: "trigger", hosting: "self-hosted" }).success).toBe(false);
    expect(withJobs({ runtime: "inngest", endpoint: "https://inngest.example.com" }).success).toBe(false);
    expect(withJobs({ runtime: "cloudflare", hosting: "self-hosted", endpoint: "https://x.example" }).success).toBe(false);
    expect(withJobs({ runtime: "inngest", hosting: "self-hosted", endpoint: "http://inngest.example.com" }).success).toBe(false);
  });
});

describe("trigger.dev provider", () => {
  it("appears only when trigger.dev is the job runtime, pointing at the selected endpoint", async () => {
    expect((await providerStatuses(manifest, "staging", {})).some((status) => status.id === "trigger")).toBe(false);
    const selfHosted = projectManifestSchema.parse({ ...manifest, jobs: { runtime: "trigger", hosting: "self-hosted", endpoint: "https://jobs.example.com", project: "proj_abc" } }) as ProjectManifest;
    const statuses = await providerStatuses(selfHosted, "staging", { TRIGGER_SECRET_KEY: "sk_wrong" });
    expect(statuses.find((status) => status.id === "trigger")).toMatchObject({ mode: "live", state: "invalid", description: expect.stringContaining("self-hosted at https://jobs.example.com") });
  });
});
