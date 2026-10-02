import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ConsumerSpec, ConsumerId } from "./consumers.js";
import { commitSnapshot, readCommittedSnapshot } from "./credentials.js";
import { ownerOutput, type ScriptRunner } from "./database-setup.js";
import { deployCredentials, markGenerationRetired, type ConsumerDeployer, type DeploymentRecord, type ProbeRunner } from "./deployment.js";
import { validatePostgresEndpoint } from "./endpoints.js";
import { redact } from "./redaction.js";
import type { OperationStore } from "./store.js";

/**
 * Rotation of the Trestle-managed database runtime credential (spec §18–§20).
 * PostgreSQL invalidates the old password immediately, so the operator must
 * accept the interruption window; consumers are cut over and verified before
 * the old generation is retired.
 */

export type RuntimeRotationInput = Readonly<{
  root: string;
  store: OperationStore;
  masterKey: string;
  projectId: string;
  environment: string;
  resource: string;
  runtimeRole: string;
  run: ScriptRunner;
  path: string;
  consumers: readonly ConsumerSpec[];
  expectedTargets: Readonly<Partial<Record<ConsumerId, string>>>;
  deployer: ConsumerDeployer;
  probes: ProbeRunner;
  artifactDigest: string;
  configDigest: string;
  /** Rejection check for the old credential: "rejected" only for a credential error (28P01). */
  oldCredentialRejected: (connection: string) => Promise<"rejected" | "accepted" | "inconclusive">;
  acceptInterruption: { actor: string; reason: string };
  probeAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Resume an interrupted rotation from its recovery envelope instead of starting a new one. */
  resumeOperationId?: string;
  now: () => Date;
}>;

export type RuntimeRotationResult = Readonly<{ state: "completed" | "partial_cutover" | "cutover_verified_retirement_unknown"; operationId: string; generations: readonly [number, number]; deployment: DeploymentRecord }>;

export async function rotateRuntimeCredential(input: RuntimeRotationInput): Promise<RuntimeRotationResult> {
  const deploymentScope = { projectId: input.projectId, environment: input.environment, purpose: "deployment" as const };
  const before = await readCommittedSnapshot(input.store, deploymentScope, input.masterKey);
  const oldUrl = before.values.DATABASE_URL;
  if (!oldUrl) throw new Error("the deployment snapshot has no DATABASE_URL; run trestle infra database setup first");
  const owner = (await readCommittedSnapshot(input.store, { projectId: input.projectId, environment: input.environment, purpose: "operator" }, input.masterKey)).values[ownerOutput(input.resource)];
  if (!owner || !validatePostgresEndpoint(owner, "neon").ok) throw new Error("operator owner credential is missing or invalid");
  if (!input.resumeOperationId && decodeURIComponent(new URL(oldUrl).username) !== input.runtimeRole) throw new Error("the deployed DATABASE_URL does not use the runtime role");

  const operationId = input.resumeOperationId ?? `op-runtime-rotate-${input.environment}-${input.resource}-${input.now().getTime()}`;
  // The new password is sealed in a recovery envelope before issuance, so a crash
  // between changing it and committing the snapshot can be resumed, not lost (AR-03).
  const recoveryScope = { projectId: `${input.projectId}.runtime.${operationId}`, environment: input.environment, purpose: "operator" as const };
  const journal = (kind: string, data: Record<string, unknown> = {}) => input.store.appendEvent(operationId, `infra.rotation.${kind}`, { resource: input.resource, ...data }, input.now());
  let newUrl: string;
  let baseGeneration: number;
  let previousUrl: string;
  if (input.resumeOperationId) {
    const recovered = await readCommittedSnapshot(input.store, recoveryScope, input.masterKey);
    if (!recovered.values.NEW_DATABASE_URL || !recovered.values.OLD_DATABASE_URL) throw new Error(`no recovery envelope for ${operationId}`);
    newUrl = recovered.values.NEW_DATABASE_URL;
    previousUrl = recovered.values.OLD_DATABASE_URL;
    baseGeneration = Number((await input.store.events(operationId)).find((event) => event.kind === "infra.rotation.preflight_passed")?.data.baseGeneration ?? before.generation);
    await journal("resumed");
  } else {
    await input.store.createOperation({ id: operationId, environment: input.environment, planDigest: `runtime-rotation:${input.resource}`, approvalId: null, state: "running" }, input.now());
    const next = new URL(oldUrl);
    next.password = randomBytes(32).toString("base64url");
    newUrl = next.toString();
    previousUrl = oldUrl;
    baseGeneration = before.generation;
    await commitSnapshot(input.store, recoveryScope, 0, { NEW_DATABASE_URL: newUrl, OLD_DATABASE_URL: oldUrl }, ["NEW_DATABASE_URL", "OLD_DATABASE_URL"].map((name) => ({ name, classification: "operator-only" as const, binding: `${input.resource}-runtime`, provider: "neon", resource: null, consumers: [], importedAt: input.now().toISOString(), override: false })), input.masterKey);
    await journal("preflight_passed", { baseGeneration, interruptionAcceptedBy: input.acceptInterruption.actor, reason: input.acceptInterruption.reason });
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), "trestle-runtime-rotate-"));
  try {
    await journal("issuance_requested");
    // Idempotent: setting the same sealed password again is harmless on resume.
    await input.run("pnpm", ["--filter", "./packages/db", "exec", "tsx", "scripts/runtime-role.ts", "bootstrap"], { cwd: input.root, env: { PATH: input.path, HOME: scratch, NODE_ENV: "production", DATABASE_DRIVER: "postgres-js", DATABASE_MIGRATION_URL: owner, DATABASE_URL: newUrl, DATABASE_RUNTIME_ROLE: input.runtimeRole } });
    await journal("new_issued");
    const current = await readCommittedSnapshot(input.store, deploymentScope, input.masterKey);
    const generation = current.values.DATABASE_URL === newUrl ? current.generation : await commitSnapshot(input.store, deploymentScope, current.generation, { ...current.values, DATABASE_URL: newUrl }, current.metadata.map((entry) => entry.name === "DATABASE_URL" ? { ...entry, importedAt: input.now().toISOString(), override: false } : entry), input.masterKey);
    await journal("encrypted_snapshot_saved", { generation });

    const deployment = await deployCredentials({ store: input.store, scope: deploymentScope, masterKey: input.masterKey, consumers: input.consumers, expectedTargets: input.expectedTargets, deployer: input.deployer, probes: input.probes, artifactDigest: input.artifactDigest, configDigest: input.configDigest, now: input.now, probeAttempts: input.probeAttempts ?? 8, ...(input.sleep ? { sleep: input.sleep } : {}) });
    await journal("consumers_updated", { generation, verified: deployment.verified });
    if (!deployment.verified) {
      await journal("partial_cutover", { unverified: deployment.consumers.filter((report) => report.state !== "verified").map((report) => report.consumer) });
      await input.store.setOperationState(operationId, "partial_cutover", input.now());
      return { state: "partial_cutover", operationId, generations: [baseGeneration, generation], deployment };
    }
    await journal("consumers_verified", { generation });
    const evidence = await input.oldCredentialRejected(previousUrl);
    if (evidence !== "rejected") {
      await journal("cutover_verified_retirement_unknown", { evidence });
      await input.store.setOperationState(operationId, "cutover_verified_retirement_unknown", input.now());
      return { state: "cutover_verified_retirement_unknown", operationId, generations: [baseGeneration, generation], deployment };
    }
    await markGenerationRetired(input.store, input.projectId, input.environment, baseGeneration);
    await journal("old_credential_retired", { retiredGeneration: baseGeneration });
    await journal("completed");
    await input.store.setOperationState(operationId, "completed", input.now());
    return { state: "completed", operationId, generations: [baseGeneration, generation], deployment };
  } catch (error) {
    await journal("needs_intervention", { reason: error instanceof Error ? redact(error.message).slice(0, 200) : "error" });
    await input.store.setOperationState(operationId, "needs_intervention", input.now());
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
