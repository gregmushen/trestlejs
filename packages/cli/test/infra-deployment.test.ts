import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { consumerRegistry, ConsumerError, generationMarker, projectionFor, type ConsumerId } from "../src/infra/consumers.js";
import { commitSnapshot, type CredentialMetadata } from "../src/infra/credentials.js";
import { deployCredentials, DeploymentError, markGenerationRetired, verificationCurrent, type ConsumerDeployer, type ProbeResult, type ProbeRunner } from "../src/infra/deployment.js";
import { parseIntent } from "../src/infra/schema.js";
import { MemoryOperationStore } from "../src/infra/stores/memory.js";
import { projectManifestSchema } from "../src/manifest.js";
import type { ProjectManifest } from "../src/core.js";

const now = () => new Date("2026-10-02T00:00:00.000Z");
const masterKey = randomBytes(32).toString("hex");
const scope = { projectId: "trestle-proj-1", environment: "staging", purpose: "deployment" as const };
const artifact = `sha256:${"ab".repeat(32)}`;
const meta = (name: string, consumers: string[], classification: CredentialMetadata["classification"] = "provider-managed"): CredentialMetadata => ({ name, classification, binding: "b", provider: "neon", resource: "r", consumers, importedAt: now().toISOString(), override: false });

const manifest = (admin: boolean) => projectManifestSchema.parse({
  schemaVersion: 1, project: { name: "fixture" }, apps: { worker: "apps/worker", ...(admin ? { admin: "apps/admin" } : {}) }, packages: {}, tenancy: { model: "organization", enforcement: "postgres-rls" }, database: { engine: "postgresql", defaultProvider: "neon" },
  capabilities: { r2: false, queues: false, workflows: false, durableObjects: false, admin }, environments: ["local", "staging"],
}) as ProjectManifest;

const intent = (consumers: string[]) => parseIntent(stringify({ schemaVersion: 1, backend: "stripe-projects", environments: { staging: { projectsBinding: "s", resources: { database: { provider: "neon", service: "postgres", plan: "free", credentialBindings: { runtime: { output: "DATABASE_URL", classification: "provider-managed", consumers } } } } } } }));

class FakeHost implements ConsumerDeployer, ProbeRunner {
  revisions = new Map<ConsumerId, { revision: string; marker: string; values: Record<string, string> }>();
  projected: Array<{ consumer: ConsumerId; target: string; names: string[] }> = [];
  targets: Partial<Record<ConsumerId, string>> = { worker: "fixture-worker-staging", admin: "fixture-admin-staging" };
  failProject = new Set<ConsumerId>();
  probeOverride: Partial<Record<ConsumerId, (actual: { revision: string; marker: string }) => ProbeResult>> = {};
  private counter = 0;
  async target(consumer: ConsumerId) { return this.targets[consumer] ?? `unknown-${consumer}`; }
  async project(consumer: ConsumerId, target: string, values: Record<string, string>, marker: string) {
    if (this.failProject.has(consumer)) throw new Error("wrangler secret bulk failed");
    this.projected.push({ consumer, target, names: Object.keys(values).sort() });
    const revision = `rev-${++this.counter}`;
    this.revisions.set(consumer, { revision, marker, values });
    return { revision };
  }
  async probe(consumer: ConsumerId): Promise<ProbeResult> {
    const actual = this.revisions.get(consumer)!;
    return this.probeOverride[consumer]?.(actual) ?? { status: "ok", revision: actual.revision, credentialGeneration: actual.marker, newConnection: true };
  }
}

async function setup(metadata: CredentialMetadata[], values: Record<string, string>) {
  const store = new MemoryOperationStore();
  await commitSnapshot(store, scope, 0, values, metadata, masterKey);
  return store;
}

const expectedTargets = { worker: "fixture-worker-staging", admin: "fixture-admin-staging" };

describe("consumer registry and projection", () => {
  it("includes only consumers the application deploys and rejects undeployed targets", () => {
    expect(consumerRegistry(manifest(false), intent(["worker"]), "staging").map((consumer) => consumer.id)).toEqual(["worker"]);
    expect(consumerRegistry(manifest(true), intent(["worker", "admin"]), "staging").map((consumer) => consumer.id)).toEqual(["admin", "worker"]);
    expect(() => consumerRegistry(manifest(false), intent(["admin"]), "staging")).toThrow(/does not deploy: admin/u);
  });

  it("projects only declared values and never operator-only credentials to application consumers", () => {
    const metadata = [meta("DATABASE_URL", ["worker"]), meta("ADMIN_TOKEN", ["admin"]), meta("OWNER_URL", ["worker"], "operator-only")];
    const values = { DATABASE_URL: "a", ADMIN_TOKEN: "b", OWNER_URL: "c" };
    expect(() => projectionFor("worker", values, metadata)).toThrow(ConsumerError);
    expect(projectionFor("admin", values, metadata)).toEqual({ ADMIN_TOKEN: "b" });
    expect(projectionFor("worker", values, metadata.slice(0, 2))).toEqual({ DATABASE_URL: "a" });
  });

  it("builds a non-secret generation marker", () => {
    expect(generationMarker("staging", 7, artifact)).toBe("staging:g7:abababababab");
    expect(() => generationMarker("staging", 7, "latest")).toThrow();
  });
});

describe("deployment generation proof", () => {
  it("verifies each consumer on the new revision and generation, keeping admin and customer values separate", async () => {
    const store = await setup([meta("DATABASE_URL", ["worker"]), meta("ADMIN_TOKEN", ["admin"])], { DATABASE_URL: "runtime-secret-1", ADMIN_TOKEN: "admin-secret-2" });
    const host = new FakeHost();
    const consumers = consumerRegistry(manifest(true), intent(["worker", "admin"]), "staging");
    const record = await deployCredentials({ store, scope, masterKey, consumers, expectedTargets, deployer: host, probes: host, artifactDigest: artifact, configDigest: "sha256:cfg", now });
    expect(record.verified).toBe(true);
    expect(host.projected).toEqual([{ consumer: "admin", target: "fixture-admin-staging", names: ["ADMIN_TOKEN"] }, { consumer: "worker", target: "fixture-worker-staging", names: ["DATABASE_URL"] }]);
    expect(record.managementPath).toBe("not_required");
    expect(JSON.stringify(await store.exportState())).not.toMatch(/runtime-secret-1|admin-secret-2/u);
  });

  it("refuses to project to a target other than the reviewed one (wrong Worker or admin target)", async () => {
    const store = await setup([meta("DATABASE_URL", ["worker"])], { DATABASE_URL: "runtime" });
    const host = new FakeHost();
    host.targets.worker = "fixture-admin-staging";
    const record = await deployCredentials({ store, scope, masterKey, consumers: consumerRegistry(manifest(false), intent(["worker"]), "staging"), expectedTargets, deployer: host, probes: host, artifactDigest: artifact, configDigest: "c", now });
    expect(record).toMatchObject({ verified: false, consumers: [{ consumer: "worker", state: "failed" }] });
    expect(host.projected).toEqual([]);
  });

  it("does not accept HTTP 200 from an old replica, a stale pool, or an unreachable probe as verification (AR-07)", async () => {
    const consumers = consumerRegistry(manifest(false), intent(["worker"]), "staging");
    const cases: Array<[string, (actual: { revision: string; marker: string }) => ProbeResult, string]> = [
      ["old replica", () => ({ status: "ok", revision: "rev-old", credentialGeneration: "staging:g1:abababababab", newConnection: true }), "deployed"],
      ["right revision, old generation", (actual) => ({ status: "ok", revision: actual.revision, credentialGeneration: "staging:g0:abababababab", newConnection: true }), "deployed"],
      ["pooled connection", (actual) => ({ status: "ok", revision: actual.revision, credentialGeneration: actual.marker, newConnection: false }), "deployed"],
      ["rate limited", () => ({ status: "rate_limited" }), "unverified"],
      ["network failure", () => ({ status: "unreachable" }), "unverified"],
    ];
    for (const [label, probe, state] of cases) {
      const store = await setup([meta("DATABASE_URL", ["worker"])], { DATABASE_URL: "runtime" });
      const host = new FakeHost();
      host.probeOverride.worker = probe;
      const record = await deployCredentials({ store, scope, masterKey, consumers, expectedTargets, deployer: host, probes: host, artifactDigest: artifact, configDigest: "c", now });
      expect(record.verified, label).toBe(false);
      expect(record.consumers[0]!.state, label).toBe(state);
    }
  });

  it("records a partial host update as incomplete rather than success", async () => {
    const store = await setup([meta("DATABASE_URL", ["worker"]), meta("ADMIN_TOKEN", ["admin"])], { DATABASE_URL: "runtime", ADMIN_TOKEN: "admin" });
    const host = new FakeHost();
    host.failProject.add("admin");
    const record = await deployCredentials({ store, scope, masterKey, consumers: consumerRegistry(manifest(true), intent(["worker", "admin"]), "staging"), expectedTargets, deployer: host, probes: host, artifactDigest: artifact, configDigest: "c", now });
    expect(record.verified).toBe(false);
    expect(Object.fromEntries(record.consumers.map((report) => [report.consumer, report.state]))).toEqual({ admin: "configured", worker: "verified" });
  });

  it("never redeploys a generation whose keys were retired, including on rollback (AR-08)", async () => {
    const store = await setup([meta("DATABASE_URL", ["worker"])], { DATABASE_URL: "old" });
    await markGenerationRetired(store, "trestle-proj-1", "staging", 1);
    const host = new FakeHost();
    const consumers = consumerRegistry(manifest(false), intent(["worker"]), "staging");
    await expect(deployCredentials({ store, scope, masterKey, consumers, expectedTargets, deployer: host, probes: host, artifactDigest: artifact, configDigest: "c", now })).rejects.toThrow(/retired keys/u);
    await expect(deployCredentials({ store, scope, masterKey, consumers, expectedTargets, deployer: host, probes: host, artifactDigest: artifact, configDigest: "c", now, credentialGeneration: 0 })).rejects.toThrow(DeploymentError);
    expect(host.projected).toEqual([]);
  });

  it("requires re-verification after configuration drift, a new generation, or a different artifact", async () => {
    const store = await setup([meta("DATABASE_URL", ["worker"])], { DATABASE_URL: "runtime" });
    const host = new FakeHost();
    const record = await deployCredentials({ store, scope, masterKey, consumers: consumerRegistry(manifest(false), intent(["worker"]), "staging"), expectedTargets, deployer: host, probes: host, artifactDigest: artifact, configDigest: "cfg-1", now });
    expect(verificationCurrent(record, { configDigest: "cfg-1", credentialGeneration: 1, artifactDigest: artifact })).toEqual({ current: true, reasons: [] });
    expect(verificationCurrent(record, { configDigest: "cfg-2", credentialGeneration: 1, artifactDigest: artifact }).reasons).toEqual(["host configuration changed since verification"]);
    expect(verificationCurrent(record, { configDigest: "cfg-1", credentialGeneration: 2, artifactDigest: artifact }).current).toBe(false);
  });

  it("distinguishes a Projects management outage (irrelevant) from a provider data-plane failure (AR-15)", async () => {
    const consumers = consumerRegistry(manifest(false), intent(["worker"]), "staging");
    const store = await setup([meta("DATABASE_URL", ["worker"])], { DATABASE_URL: "runtime" });
    // No Projects adapter is involved at all: deployment reads the committed snapshot from the control store.
    const healthy = new FakeHost();
    expect((await deployCredentials({ store, scope, masterKey, consumers, expectedTargets, deployer: healthy, probes: healthy, artifactDigest: artifact, configDigest: "c", now })).verified).toBe(true);
    const outage = new FakeHost();
    outage.probeOverride.worker = () => ({ status: "error" });
    const record = await deployCredentials({ store, scope, masterKey, consumers, expectedTargets, deployer: outage, probes: outage, artifactDigest: artifact, configDigest: "c", now });
    expect(record.consumers[0]).toMatchObject({ state: "unverified", detail: expect.stringMatching(/data plane/u) });
  });
});

describe("propagation window (observed with Wrangler)", () => {
  it("re-probes until the new generation appears, without ever counting a stale answer", async () => {
    const store = await setup([meta("DATABASE_URL", ["worker"])], { DATABASE_URL: "runtime" });
    const host = new FakeHost();
    let calls = 0;
    host.probeOverride.worker = (actual) => (++calls < 3 ? { status: "ok", revision: "rev-old", credentialGeneration: "staging:g0:abababababab", newConnection: true } : { status: "ok", revision: actual.revision, credentialGeneration: actual.marker, newConnection: true });
    const sleeps: number[] = [];
    const record = await deployCredentials({ store, scope, masterKey, consumers: consumerRegistry(manifest(false), intent(["worker"]), "staging"), expectedTargets, deployer: host, probes: host, artifactDigest: artifact, configDigest: "c", now, probeAttempts: 5, sleep: async (ms) => { sleeps.push(ms); } });
    expect(record.verified).toBe(true);
    expect(sleeps).toHaveLength(2);
    const stale = new FakeHost();
    stale.probeOverride.worker = () => ({ status: "ok", revision: "rev-old", credentialGeneration: "staging:g0:abababababab", newConnection: true });
    const never = await deployCredentials({ store, scope, masterKey, consumers: consumerRegistry(manifest(false), intent(["worker"]), "staging"), expectedTargets, deployer: stale, probes: stale, artifactDigest: artifact, configDigest: "c", now, probeAttempts: 3, sleep: async () => {} });
    expect(never).toMatchObject({ verified: false, consumers: [{ state: "deployed" }] });
  });
});
