import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseProjectManifest } from "@trestlejs/core";
import { afterEach, describe, expect, it } from "vitest";

import { readSecrets } from "../src/secrets.js";
import { loadSetupPlan, startSetupConsole } from "../src/setup.js";

const temporary: string[] = [];
afterEach(async () => await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-setup-"));
  temporary.push(root);
  await mkdir(path.join(root, ".trestle"));
  const manifest = parseProjectManifest(`schemaVersion: 1
project: { name: fixture }
apps: { app: apps/app, worker: apps/worker }
packages: { contracts: packages/contracts }
tenancy: { model: organization, enforcement: postgres-rls }
database: { engine: postgresql, defaultProvider: neon }
capabilities: { r2: false, queues: false, workflows: false, durableObjects: false, admin: false }
environments: [local]
secrets:
  TEST_SECRET: { target: worker, required: [local] }
`);
  await writeFile(path.join(root, ".trestle", "project.yaml"), "fixture");
  return { root, manifest };
}

describe("local setup console", () => {
  it("derives a plan without writing files and requires a saved plan for resume", async () => {
    const { root, manifest } = await fixture();
    const draft = await loadSetupPlan(root, manifest);
    expect(draft.saved).toBe(false);
    expect(draft.plan.secrets).toEqual([{ name: "TEST_SECRET", target: "worker", required: ["local"] }]);
    await expect(loadSetupPlan(root, manifest, true)).rejects.toThrow("No saved SetupPlan");
  });

  it("binds to loopback, requires one-time access and CSRF, and encrypts secrets without echoing values", async () => {
    const { root, manifest } = await fixture();
    const console = await startSetupConsole(root, manifest, "local");
    try {
      expect(console.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
      const anonymous = await fetch(console.url);
      expect(await anonymous.text()).toContain("One-time access code");

      const invalid = await fetch(new URL("/session", console.url), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: "wrong" }), redirect: "manual" });
      expect(invalid.status).toBe(403);
      const login = await fetch(new URL("/session", console.url), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: console.accessCode }), redirect: "manual" });
      expect(login.status).toBe(303);
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toContain("trestle_setup=");
      const repeated = await fetch(new URL("/session", console.url), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: console.accessCode }), redirect: "manual" });
      expect(repeated.status).toBe(403);

      const review = await fetch(console.url, { headers: { cookie: cookie! } });
      const html = await review.text();
      expect(html).toContain("SetupPlan draft");
      const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
      expect(csrf).toBeDefined();
      const rejected = await fetch(new URL("/secret", console.url), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie! }, body: new URLSearchParams({ csrf: "wrong", name: "TEST_SECRET", value: "swordfish" }), redirect: "manual" });
      expect(rejected.status).toBe(403);
      const stored = await fetch(new URL("/secret", console.url), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie! }, body: new URLSearchParams({ csrf: csrf!, name: "TEST_SECRET", value: "swordfish" }), redirect: "manual" });
      expect(stored.status).toBe(303);
      const invalidName = await fetch(new URL("/secret", console.url), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie! }, body: new URLSearchParams({ csrf: csrf!, name: "swordfish", value: "swordfish" }), redirect: "manual" });
      expect(invalidName.status).toBe(400);
      expect(await invalidName.text()).not.toContain("swordfish");
      const after = await (await fetch(console.url, { headers: { cookie: cookie! } })).text();
      expect(after).toContain("present");
      expect(after).not.toContain("swordfish");
      expect(await readSecrets(root, "local")).toEqual({ TEST_SECRET: "swordfish" });
      expect(await readFile(path.join(root, "config", "credentials.yml.enc"), "utf8")).not.toContain("swordfish");

      const plan = await loadSetupPlan(root, manifest);
      const saved = await fetch(new URL("/plan", console.url), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie! }, body: new URLSearchParams({ csrf: csrf!, plan: plan.input }), redirect: "manual" });
      expect(saved.status).toBe(303);
      expect((await loadSetupPlan(root, manifest, true)).saved).toBe(true);
      const applied = await fetch(new URL("/apply", console.url), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie! }, body: new URLSearchParams({ csrf: csrf! }), redirect: "manual" });
      expect(applied.status).toBe(303);
      expect(JSON.parse(await readFile(path.join(root, ".trestle", "setup.state.json"), "utf8"))).toMatchObject({ schemaVersion: 1, operations: [] });
    } finally {
      await console.close();
    }
  });
});
