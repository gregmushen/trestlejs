import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseProjectManifest, type EvidenceDocument } from "@trestlejs/core";
import { afterEach, describe, expect, it } from "vitest";

import { inspectCapabilities, readEvidence } from "../src/capabilities.js";
import { providerChecks } from "../src/doctor.js";
import { verifyScimTransactions } from "../src/identity.js";
import { initializeSecrets } from "../src/secrets.js";
import { providerBaseUrl, providerCheckEvidence, testConnection, type ConnectionResult } from "../src/setup/connections.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const manifestText = `schemaVersion: 1
project:
  name: fixture
apps:
  app: apps/app
  worker: apps/worker
  admin: apps/admin
packages:
  auth: packages/auth
  billing: packages/billing
  events: packages/events
tenancy:
  model: organization
  enforcement: postgres-rls
database:
  engine: postgresql
  defaultProvider: neon
capabilities:
  r2: false
  queues: false
  workflows: false
  durableObjects: false
  admin: true
integrations:
  email: local
  payments: stripe
  metering: openmeter
  webhooks: svix
authentication:
  passkeys: better-auth
  twoFactor: better-auth
identity:
  sso: better-auth
  directory: better-auth-scim
communications:
  webhooks: true
  notifications: false
commercial:
  plans: true
  usage: true
environments: [local, staging]
secrets:
  DATABASE_URL:
    target: worker
    required: [local, staging]
  DATABASE_DRIVER:
    target: worker
    required: [local, staging]
  OPENMETER_API_KEY:
    target: worker
    required: [staging]
  SVIX_API_KEY:
    target: worker
    required: [staging]
`;

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-providers-"));
  directories.push(root);
  await mkdir(path.join(root, ".trestle"), { recursive: true });
  await writeFile(path.join(root, ".trestle", "project.yaml"), manifestText);
  for (const directory of ["apps/admin", "apps/worker", "packages/auth", "packages/billing", "packages/events"]) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, "package.json"), "{}\n");
  }
  return { root, manifest: parseProjectManifest(manifestText) };
}

const evidence = (scim?: EvidenceDocument["scimTransactions"], providerChecksValue?: EvidenceDocument["providerChecks"]): EvidenceDocument => ({
  schemaVersion: 1, environment: "staging", recordedAt: "2026-09-22T00:00:00.000Z",
  capabilities: { directory: { deployed: true, verified: true, checkedAt: "x" } },
  ...(scim ? { scimTransactions: scim } : {}),
  ...(providerChecksValue ? { providerChecks: providerChecksValue } : {}),
});

describe("enterprise identity and provider gates", () => {
  it("refuses to verify self-hosted SCIM without a passing transaction test on the environment's driver", async () => {
    const { root, manifest } = await project();
    const secrets = { DATABASE_URL: "set", DATABASE_DRIVER: "postgres-js", OPENMETER_API_KEY: "set", SVIX_API_KEY: "set" };
    const state = async (document: EvidenceDocument) => (await inspectCapabilities(root, manifest, "staging", { secrets, evidence: document })).capabilities.find((capability) => capability.id === "directory")!.state;
    expect(await state(evidence())).toBe("deployed");
    expect(await state(evidence({ driver: "neon-http", passed: true, operations: ["create", "update", "deactivate"], checkedAt: "x" }))).toBe("deployed");
    expect(await state(evidence({ driver: "postgres-js", passed: false, operations: ["create"], checkedAt: "x", failure: "no transactions" }))).toBe("deployed");
    expect(await state(evidence({ driver: "postgres-js", passed: true, operations: ["create", "update", "deactivate"], checkedAt: "x" }))).toBe("verified");

    const gate = (document: EvidenceDocument | undefined, driver = "postgres-js") => providerChecks(manifest, "staging", { DATABASE_DRIVER: driver }, document).find((check) => check.id === "identity.scim.transactions")!;
    expect(gate(undefined)).toMatchObject({ status: "fail", message: expect.stringMatching(/no transaction test/u) });
    expect(gate(evidence({ driver: "postgres-js", passed: true, operations: ["create", "update", "deactivate"], checkedAt: "x" }), "neon-http")).toMatchObject({ status: "fail", message: expect.stringMatching(/verified on postgres-js, but staging uses neon-http/u) });
    expect(gate(evidence({ driver: "postgres-js", passed: true, operations: ["create", "update", "deactivate"], checkedAt: "x" }))).toMatchObject({ status: "pass" });
    expect(providerChecks(manifest, "staging", { DATABASE_DRIVER: "neon-http" }, undefined).find((check) => check.id === "identity.sso.transactions")).toMatchObject({ status: "fail" });
  });

  it("requires a recorded connection check for each provider outside local", async () => {
    const { manifest } = await project();
    const checks = (document?: EvidenceDocument) => Object.fromEntries(providerChecks(manifest, "staging", { DATABASE_DRIVER: "postgres-js" }, document).filter((check) => check.id.startsWith("providers.")).map((check) => [check.id, check.status]));
    expect(checks()).toEqual({ "providers.openmeter.connection": "warn", "providers.svix.connection": "warn" });
    expect(checks(evidence(undefined, { metering: { provider: "openmeter", ok: true, checkedAt: "x" }, webhooks: { provider: "svix", ok: false, checkedAt: "x", failure: "The provider rejected the credential" } })))
      .toEqual({ "providers.openmeter.connection": "pass", "providers.svix.connection": "fail" });
    expect(providerChecks(manifest, "local", {}, undefined).filter((check) => check.id.startsWith("providers."))).toEqual([]);
  });

  it("records connection results as non-secret evidence", async () => {
    const fetcher = (async (url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk_svix");
      return new Response("{}", { status: url.startsWith("http://localhost:8071/api/v1/app") ? 200 : 500 });
    }) as typeof fetch;
    const result = await testConnection("svix", { SVIX_API_KEY: "sk_svix", SVIX_SERVER_URL: "http://localhost:8071/" }, fetcher, () => new Date("2026-09-22T00:00:00Z"));
    expect(result).toMatchObject({ ok: true, status: "reachable" });
    const results = new Map<string, ConnectionResult>([["staging:svix", result], ["staging:neon", { ...result, provider: "neon" }], ["local:openmeter", { ...result, provider: "openmeter", ok: false, status: "unauthorized" }]]);
    const folded = providerCheckEvidence(undefined, "staging", results);
    expect(folded).toEqual({ providerChecks: { webhooks: { provider: "svix", ok: true, checkedAt: "2026-09-22T00:00:00.000Z" } } });
    expect(JSON.stringify(folded)).not.toContain("sk_svix");
    expect(providerBaseUrl("http://evil.example/", "https://api.svix.com")).toBe("https://api.svix.com");
    expect(providerBaseUrl("https://user:pw@eu.svix.example/", "https://api.svix.com")).toBe("https://api.svix.com");
    expect(providerBaseUrl("https://openmeter.example/base/", "https://openmeter.cloud")).toBe("https://openmeter.example/base");
  });

  it("runs the generated transaction test with the environment's credentials and records the result", async () => {
    const { root, manifest } = await project();
    await initializeSecrets(root, "local", { DATABASE_URL: "postgres://local/db", DATABASE_DRIVER: "postgres-js" });
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const passing = async (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, ...(options.env ? { env: options.env } : {}) });
      await writeFile(options.env!.TRESTLE_SCIM_RESULT!, JSON.stringify({ driver: "postgres-js", passed: true, operations: ["create", "update", "deactivate"], checkedAt: "2026-09-22T00:00:00.000Z" }));
      return { stdout: "", stderr: "" };
    };
    const result = await verifyScimTransactions(root, manifest, "local", undefined, passing);
    expect(result.passed).toBe(true);
    expect(calls[0]).toMatchObject({ command: "pnpm", args: ["--filter", "./packages/auth", "exec", "tsx", "src/scim-transactions.ts"], env: { DATABASE_URL: "postgres://local/db", DATABASE_DRIVER: "postgres-js" } });
    expect((await readEvidence(root, "local"))?.scimTransactions).toMatchObject({ driver: "postgres-js", passed: true });

    const crashing = async () => { throw new Error("boom"); };
    const failed = await verifyScimTransactions(root, manifest, "local", undefined, crashing);
    expect(failed).toMatchObject({ passed: false, driver: "postgres-js" });
    expect(JSON.parse(await readFile(path.join(root, ".trestle", "evidence", "local.json"), "utf8")).scimTransactions.passed).toBe(false);
  });
});
