import { canonicalDigest } from "./canonical.js";
import { generationMarker, projectionFor, type ConsumerId, type ConsumerSpec } from "./consumers.js";
import { readCommittedSnapshot, snapshotScopeKey, type SnapshotScope } from "./credentials.js";
import type { OperationStore } from "./store.js";

/**
 * Deployment handoff with per-consumer generation proof (spec §20, plan P08).
 * Provisioned, configured, deployed and verified are recorded separately; a
 * green health check from an old replica never counts as verification.
 */

export type ConsumerState = "pending" | "configured" | "deployed" | "verified" | "unverified" | "failed";

export type ProbeResult = Readonly<{
  status: "ok" | "unreachable" | "rate_limited" | "error";
  revision?: string;
  credentialGeneration?: string | null;
  /** Whether the probe opened a fresh dependency connection rather than reusing a pool. */
  newConnection?: boolean;
}>;

export interface ConsumerDeployer {
  /** The host target this consumer resolves to, from the reviewed host configuration. */
  target(consumer: ConsumerId): Promise<string>;
  /** Projects the values and marker; returns the new immutable host revision. */
  project(consumer: ConsumerId, target: string, values: Readonly<Record<string, string>>, marker: string, artifactDigest: string): Promise<{ revision: string }>;
}

export interface ProbeRunner {
  probe(consumer: ConsumerId, target: string): Promise<ProbeResult>;
}

export type ConsumerReport = Readonly<{ consumer: ConsumerId; target: string | null; state: ConsumerState; revision: string | null; detail: string }>;

export type DeploymentRecord = Readonly<{
  artifactDigest: string;
  configDigest: string;
  credentialGeneration: number;
  marker: string;
  consumers: readonly ConsumerReport[];
  /** True only when every declared consumer is verified on this generation. */
  verified: boolean;
  /** Projects is not consulted during deployment; its outage cannot block or fake this record. */
  managementPath: "not_required";
  recordedAt: string;
}>;

export class DeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentError";
  }
}

export function deploymentScope(projectId: string, environment: string): string {
  return `deployments:${projectId}:${environment}`;
}

export function retiredScope(projectId: string, environment: string): string {
  return `retired:${projectId}:${environment}`;
}

/** Credential generations whose keys have been retired; they can never be deployed again (AR-08). */
export async function retiredGenerations(store: OperationStore, projectId: string, environment: string): Promise<{ generation: number; retired: number[] }> {
  const record = await store.readGeneration(retiredScope(projectId, environment));
  return { generation: record?.generation ?? 0, retired: [...((record?.data.generations as number[] | undefined) ?? [])] };
}

export async function markGenerationRetired(store: OperationStore, projectId: string, environment: string, credentialGeneration: number): Promise<void> {
  const current = await retiredGenerations(store, projectId, environment);
  if (current.retired.includes(credentialGeneration)) return;
  const generations = [...current.retired, credentialGeneration].sort((left, right) => left - right);
  await store.commitGeneration(retiredScope(projectId, environment), current.generation, canonicalDigest(generations), { generations });
}

export type DeployInput = Readonly<{
  store: OperationStore;
  scope: SnapshotScope;
  masterKey: string;
  consumers: readonly ConsumerSpec[];
  /** Reviewed expected host target per consumer; the deployer must agree. */
  expectedTargets: Readonly<Partial<Record<ConsumerId, string>>>;
  deployer: ConsumerDeployer;
  probes: ProbeRunner;
  artifactDigest: string;
  configDigest: string;
  now: () => Date;
  /** Deploy an older committed generation (rollback); defaults to the latest. */
  credentialGeneration?: number;
  /**
   * Host updates propagate over seconds (observed with Wrangler), so a consumer
   * is re-probed until it reports the new generation or attempts run out. A
   * stale or failing answer is never counted as verified.
   */
  probeAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}>;

/**
 * Projects the committed deployment snapshot to each declared application
 * consumer, then proves each one runs the new generation. Partial success is
 * recorded as such; nothing is reported verified on HTTP 200 alone.
 */
export async function deployCredentials(input: DeployInput): Promise<DeploymentRecord> {
  if (input.scope.purpose !== "deployment") throw new DeploymentError("only deployment snapshots are projected to consumers");
  const committed = await readCommittedSnapshot(input.store, input.scope, input.masterKey);
  if (committed.generation === 0) throw new DeploymentError("no committed deployment snapshot exists");
  const generation = input.credentialGeneration ?? committed.generation;
  if (generation !== committed.generation) throw new DeploymentError(`generation ${generation} is not the committed snapshot (${committed.generation}); historical snapshots are not retained for redeploy`);
  const { retired } = await retiredGenerations(input.store, input.scope.projectId, input.scope.environment);
  if (retired.includes(generation)) throw new DeploymentError(`credential generation ${generation} contains retired keys and cannot be deployed`);
  const marker = generationMarker(input.scope.environment, generation, input.artifactDigest);
  const reports: ConsumerReport[] = [];
  for (const consumer of input.consumers.filter((spec) => spec.plane === "application")) {
    const expected = input.expectedTargets[consumer.id];
    const target = await input.deployer.target(consumer.id);
    if (!expected || target !== expected) {
      reports.push({ consumer: consumer.id, target, state: "failed", revision: null, detail: `host target ${target} does not match the reviewed target ${expected ?? "(none)"}; nothing was projected` });
      continue;
    }
    const values = projectionFor(consumer.id, committed.values, committed.metadata);
    let revision: string;
    try {
      revision = (await input.deployer.project(consumer.id, target, values, marker, input.artifactDigest)).revision;
    } catch (error) {
      reports.push({ consumer: consumer.id, target, state: "configured", revision: null, detail: `host update failed: ${error instanceof Error ? error.message.slice(0, 200) : "error"}` });
      continue;
    }
    const attempts = Math.max(1, input.probeAttempts ?? 1);
    let report = verify(consumer, target, revision, marker, await input.probes.probe(consumer.id, target));
    for (let attempt = 2; attempt <= attempts && report.state !== "verified"; attempt += 1) {
      await (input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(Math.min(10_000, 1000 * attempt));
      report = verify(consumer, target, revision, marker, await input.probes.probe(consumer.id, target));
    }
    reports.push(report);
  }
  const record: DeploymentRecord = {
    artifactDigest: input.artifactDigest, configDigest: input.configDigest, credentialGeneration: generation, marker,
    consumers: reports, verified: reports.length > 0 && reports.every((report) => report.state === "verified"), managementPath: "not_required", recordedAt: input.now().toISOString(),
  };
  const scope = deploymentScope(input.scope.projectId, input.scope.environment);
  const previous = await input.store.readGeneration(scope);
  await input.store.commitGeneration(scope, previous?.generation ?? 0, canonicalDigest(record), { record, snapshotScope: snapshotScopeKey(input.scope) });
  return record;
}

function verify(consumer: ConsumerSpec, target: string, revision: string, marker: string, probe: ProbeResult): ConsumerReport {
  const base = { consumer: consumer.id, target, revision };
  if (probe.status === "rate_limited" || probe.status === "unreachable") return { ...base, state: "unverified", detail: `probe ${probe.status}; generation use is unknown` };
  if (probe.status === "error") return { ...base, state: "unverified", detail: "the deployed consumer reported a dependency error (provider data plane or credentials); not verified" };
  if (probe.revision !== revision) return { ...base, state: "deployed", detail: `probe answered from revision ${probe.revision ?? "unknown"}, not ${revision}` };
  if (probe.credentialGeneration !== marker) return { ...base, state: "deployed", detail: `probe reports credential generation ${probe.credentialGeneration ?? "none"}, expected ${marker}` };
  if (consumer.requiresNewConnection && probe.newConnection !== true) return { ...base, state: "deployed", detail: "probe did not open a fresh connection; an existing pool can hide a failed new credential" };
  return { ...base, state: "verified", detail: `revision ${revision} uses ${marker}` };
}

/** Whether recorded verification still applies: configuration drift or a newer generation requires re-verification. */
export function verificationCurrent(record: DeploymentRecord, current: { configDigest: string; credentialGeneration: number; artifactDigest: string }): { current: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!record.verified) reasons.push("the last deployment was not fully verified");
  if (record.configDigest !== current.configDigest) reasons.push("host configuration changed since verification");
  if (record.credentialGeneration !== current.credentialGeneration) reasons.push(`credential generation changed (${record.credentialGeneration} → ${current.credentialGeneration})`);
  if (record.artifactDigest !== current.artifactDigest) reasons.push("application artifact changed since verification");
  return { current: reasons.length === 0, reasons };
}
