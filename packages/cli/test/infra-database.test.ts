import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { commitSnapshot, readCommittedSnapshot } from "../src/infra/credentials.js";
import { setupDatabase, type ScriptRunner } from "../src/infra/database-setup.js";
import { retiredGenerations } from "../src/infra/deployment.js";
import { rotateRuntimeCredential } from "../src/infra/runtime-rotation.js";
import { MemoryOperationStore } from "../src/infra/stores/memory.js";
import { OperationalHealthProbe, WranglerDeployer } from "../src/infra/wrangler-deployer.js";
import { projectManifestSchema } from "../src/manifest.js";
import type { ProjectManifest } from "../src/core.js";

const masterKey = randomBytes(32).toString("hex");
const OWNER = "postgres://neondb_owner:owner-secret-pw@ep-cool-1.us-east-1.aws.neon.tech/neondb?sslmode=require";
const HOST = "ep-cool-1.us-east-1.aws.neon.tech";
let clock = Date.parse("2026-10-02T05:00:00.000Z");
const now = () => new Date(clock++);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function storeWithOwner() {
  const store = new MemoryOperationStore();
  await commitSnapshot(store, { projectId: "p1", environment: "staging", purpose: "operator" }, 0, { TDB_CONNECTION_STRING: OWNER }, [{ name: "TDB_CONNECTION_STRING", classification: "operator-only", binding: "owner", provider: "neon", resource: "fres_1", consumers: [], importedAt: now().toISOString(), override: false }], masterKey);
  return store;
}

/** Simulates the template db scripts and records every call and its environment. */
function fakeScripts(options: { runtimeUrl?: (env: Record<string, string>) => string; failOn?: string } = {}) {
  const calls: Array<{ args: readonly string[]; env: Readonly<Record<string, string>> }> = [];
  const passwords: string[] = [];
  const run: ScriptRunner = async (_command, args, { env }) => {
    calls.push({ args, env });
    const operation = args.at(-1)!;
    if (options.failOn === operation) throw new Error(`script ${operation} failed at ${env.DATABASE_URL ?? ""}`);
    if (operation === "bootstrap-managed") {
      const url = options.runtimeUrl?.(env) ?? `postgres://${env.DATABASE_RUNTIME_ROLE}:derived-runtime-pw@${HOST}/neondb?sslmode=require`;
      await writeFile(env.TRESTLE_RUNTIME_OUTPUT!, `runtime_url=${url}\n`, { mode: 0o600 });
    }
    if (operation === "bootstrap") passwords.push(new URL(env.DATABASE_URL!).password);
  };
  return { run, calls, passwords };
}

const setupInput = (store: MemoryOperationStore, run: ScriptRunner, overrides: Partial<Parameters<typeof setupDatabase>[0]> = {}) => ({ root: "/app", store, masterKey, projectId: "p1", environment: "staging", resource: "tdb", externalId: "fres_1", runtimeRole: "trestle_runtime", consumers: ["worker"] as const, run, path: "/usr/bin:/bin", now, ...overrides });

describe("database setup through the template pipeline", () => {
  it("migrates and configures with the owner, then commits only the verified runtime credential", async () => {
    const store = await storeWithOwner();
    const scripts = fakeScripts();
    const result = await setupDatabase(setupInput(store, scripts.run));
    expect(scripts.calls.map((call) => call.args.join(" "))).toEqual([
      "db:migrate",
      "--filter ./packages/db exec tsx scripts/runtime-role.ts bootstrap-managed",
      "--filter ./packages/db exec tsx scripts/runtime-role.ts configure",
      "--filter ./packages/db exec tsx scripts/runtime-role.ts verify",
    ]);
    // Scripts see only database credentials and a scratch HOME.
    for (const call of scripts.calls) {
      expect(Object.keys(call.env).sort()).toEqual(expect.arrayContaining(["DATABASE_DRIVER", "HOME", "NODE_ENV", "PATH"]));
      expect(call.env.HOME).not.toBe(os.homedir());
      expect(Object.keys(call.env).some((key) => /STRIPE|CLOUDFLARE|RESEND|TRESTLE_MASTER/u.test(key))).toBe(false);
    }
    expect(scripts.calls[3]!.env.DATABASE_URL).toContain("trestle_runtime:");
    const deployment = await readCommittedSnapshot(store, { projectId: "p1", environment: "staging", purpose: "deployment" }, masterKey);
    expect(deployment.values).toEqual({ DATABASE_URL: `postgres://trestle_runtime:derived-runtime-pw@${HOST}/neondb?sslmode=require` });
    expect(deployment.metadata[0]).toMatchObject({ consumers: ["worker"], classification: "provider-managed", binding: "tdb-runtime" });
    expect(JSON.stringify(deployment.values)).not.toContain("owner-secret-pw");
    expect(result).toMatchObject({ deploymentGeneration: 1, runtimeRole: "trestle_runtime", host: HOST });
  });

  it("refuses an owner runtime role, a different host, a non-runtime user, or a missing owner credential", async () => {
    await expect(setupDatabase(setupInput(await storeWithOwner(), fakeScripts().run, { runtimeRole: "neondb_owner" }))).rejects.toThrow(/other than the owner/u);
    await expect(setupDatabase(setupInput(await storeWithOwner(), fakeScripts({ runtimeUrl: () => "postgres://trestle_runtime:x@ep-evil.us-east-1.aws.neon.tech/db?sslmode=require" }).run))).rejects.toThrow(/does not match/u);
    await expect(setupDatabase(setupInput(await storeWithOwner(), fakeScripts({ runtimeUrl: () => `postgres://neondb_owner:x@${HOST}/db?sslmode=require` }).run))).rejects.toThrow(/does not use the runtime role/u);
    await expect(setupDatabase(setupInput(new MemoryOperationStore(), fakeScripts().run))).rejects.toThrow(/no TDB_CONNECTION_STRING/u);
  });

  it("journals a redacted failure and commits nothing when verification fails", async () => {
    const store = await storeWithOwner();
    await expect(setupDatabase(setupInput(store, fakeScripts({ failOn: "verify" }).run))).rejects.toThrow();
    const snapshot = await store.exportState();
    expect(snapshot.generations.some((generation) => generation.scope.endsWith(":deployment"))).toBe(false);
    const failed = snapshot.events.find((event) => event.kind === "infra.database.failed");
    expect(JSON.stringify(failed)).not.toMatch(/derived-runtime-pw|owner-secret-pw/u);
    expect(snapshot.operations[0]?.state).toBe("needs_intervention");
  });
});

async function workerProject(): Promise<{ root: string; manifest: ProjectManifest }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-wrangler-"));
  directories.push(root);
  await mkdir(path.join(root, "apps", "worker"), { recursive: true });
  await writeFile(path.join(root, "apps", "worker", "wrangler.jsonc"), `{\n  "name": "fixture-worker",\n  "env": {\n    "staging": {\n      "name": "fixture-worker-staging"\n    }\n  }\n}\n`);
  const manifest = projectManifestSchema.parse({ schemaVersion: 1, project: { name: "fixture" }, apps: { worker: "apps/worker" }, packages: {}, tenancy: { model: "organization", enforcement: "postgres-rls" }, database: { engine: "postgresql", defaultProvider: "neon" }, capabilities: { r2: false, queues: false, workflows: false, durableObjects: false, admin: false }, environments: ["local", "staging"] }) as ProjectManifest;
  return { root, manifest };
}

describe("Wrangler deployer and operational health probe", () => {
  it("resolves the reviewed target and sends values plus the marker on stdin only", async () => {
    const { root, manifest } = await workerProject();
    const runs: Array<{ args: string[]; input: string }> = [];
    const deployer = new WranglerDeployer(root, manifest, "staging", async (_command, args, options) => { runs.push({ args, input: options.input }); }, {});
    expect(await deployer.target("worker")).toBe("fixture-worker-staging");
    expect(await deployer.project("worker", "fixture-worker-staging", { DATABASE_URL: "postgres://r:pw@h/db" }, "staging:g2:abababababab")).toEqual({ revision: "staging:g2:abababababab" });
    expect(runs[0]!.args).toEqual(["--filter", "@fixture/worker", "exec", "wrangler", "secret", "bulk", "--env", "staging"]);
    expect(runs[0]!.args.join(" ")).not.toContain("pw");
    expect(JSON.parse(runs[0]!.input)).toEqual({ DATABASE_URL: "postgres://r:pw@h/db", TRESTLE_CREDENTIAL_GENERATION: "staging:g2:abababababab" });
    await expect(deployer.target("admin")).rejects.toThrow(/no Worker application/u);
    await expect(deployer.project("worker", "bad name;rm", {}, "m")).rejects.toThrow(/unsafe/u);
  });

  it("verifies generation and a fresh connection as the runtime role, and classifies failures honestly", async () => {
    const respond = (status: number, body: unknown) => async () => ({ status, json: async () => body });
    const probe = (fetcher: ConstructorParameters<typeof OperationalHealthProbe>[2]) => new OperationalHealthProbe({ worker: "https://fixture-worker-staging.example.workers.dev" }, "trestle_runtime", fetcher).probe("worker");
    expect(await probe(respond(200, { credentialGeneration: "staging:g2:x", database: { freshConnection: true, role: "trestle_runtime" } }))).toEqual({ status: "ok", revision: "staging:g2:x", credentialGeneration: "staging:g2:x", newConnection: true });
    expect(await probe(respond(200, { credentialGeneration: "staging:g2:x", database: { freshConnection: true, role: "neondb_owner" } }))).toEqual({ status: "error" });
    expect(await probe(respond(200, { credentialGeneration: "staging:g2:x", database: { freshConnection: false, role: null, error: "28P01" } }))).toEqual({ status: "error" });
    expect(await probe(respond(429, {}))).toEqual({ status: "rate_limited" });
    expect(await probe(respond(503, {}))).toEqual({ status: "error" });
    expect(await probe(async () => { throw new Error("ECONNRESET"); })).toEqual({ status: "unreachable" });
    expect(await new OperationalHealthProbe({ worker: "http://insecure.example" }, "trestle_runtime", respond(200, {})).probe("worker")).toEqual({ status: "unreachable" });
  });
});

describe("runtime credential rotation", () => {
  const consumers = [{ id: "worker" as const, requiresNewConnection: true, plane: "application" as const }];
  async function rotationSetup() {
    const store = await storeWithOwner();
    await setupDatabase(setupInput(store, fakeScripts().run));
    const deployed = new Map<string, string>();
    const deployer = { target: async () => "fixture-worker-staging", project: async (_c: string, _t: string, values: Readonly<Record<string, string>>, marker: string) => { deployed.set("url", values.DATABASE_URL!); deployed.set("marker", marker); return { revision: marker }; } };
    const probes = { probe: async () => ({ status: "ok" as const, revision: deployed.get("marker")!, credentialGeneration: deployed.get("marker")!, newConnection: true }) };
    return { store, deployer, probes, deployed };
  }
  const rotationInput = (context: Awaited<ReturnType<typeof rotationSetup>>, run: ScriptRunner, overrides: Partial<Parameters<typeof rotateRuntimeCredential>[0]> = {}) => ({ root: "/app", store: context.store, masterKey, projectId: "p1", environment: "staging", resource: "tdb", runtimeRole: "trestle_runtime", run, path: "/usr/bin:/bin", consumers, expectedTargets: { worker: "fixture-worker-staging" }, deployer: context.deployer, probes: context.probes, artifactDigest: `sha256:${"ab".repeat(32)}`, configDigest: "cfg", oldCredentialRejected: async () => "rejected" as const, acceptInterruption: { actor: "greg", reason: "test window" }, now, ...overrides });

  it("issues a new password, cuts the Worker over, proves rejection and retires the old generation", async () => {
    const context = await rotationSetup();
    const scripts = fakeScripts();
    const result = await rotateRuntimeCredential(rotationInput(context, scripts.run));
    expect(result).toMatchObject({ state: "completed", generations: [1, 2], deployment: { verified: true } });
    expect(new URL(context.deployed.get("url")!).password).toBe(scripts.passwords[0]);
    expect((await retiredGenerations(context.store, "p1", "staging")).retired).toEqual([1]);
    expect(JSON.stringify(await context.store.exportState())).not.toContain(scripts.passwords[0]!);
  });

  it("does not retire on partial cutover or inconclusive rejection", async () => {
    const partial = await rotationSetup();
    const unverified = await rotateRuntimeCredential(rotationInput(partial, fakeScripts().run, { probes: { probe: async () => ({ status: "unreachable" as const }) } }));
    expect(unverified.state).toBe("partial_cutover");
    expect((await retiredGenerations(partial.store, "p1", "staging")).retired).toEqual([]);
    const inconclusive = await rotationSetup();
    expect((await rotateRuntimeCredential(rotationInput(inconclusive, fakeScripts().run, { oldCredentialRejected: async () => "inconclusive" as const }))).state).toBe("cutover_verified_retirement_unknown");
    expect((await retiredGenerations(inconclusive.store, "p1", "staging")).retired).toEqual([]);
  });

  it("resumes after a crash between issuance and commit with the sealed password, not a new one (AR-03)", async () => {
    const context = await rotationSetup();
    const first = fakeScripts();
    let crashed = false;
    const crashingRun: ScriptRunner = async (command, args, options) => { await first.run(command, args, options); if (!crashed && args.at(-1) === "bootstrap") { crashed = true; throw new Error("killed after issuance"); } };
    await expect(rotateRuntimeCredential(rotationInput(context, crashingRun))).rejects.toThrow("killed");
    const operationId = (await context.store.exportState()).operations.find((operation) => operation.id.startsWith("op-runtime-rotate"))!.id;
    const second = fakeScripts();
    const resumed = await rotateRuntimeCredential(rotationInput(context, second.run, { resumeOperationId: operationId }));
    expect(resumed.state).toBe("completed");
    expect(second.passwords[0]).toBe(first.passwords[0]);
    expect(new URL(context.deployed.get("url")!).password).toBe(first.passwords[0]);
  });
});
