import type { MutatingAdapter } from "./adapters/stripe-projects.js";
import { approvalCovers, type SignedApproval } from "./approvals.js";
import type { CommandEffect, Toolchain } from "./capabilities.js";
import { canonicalDigest } from "./canonical.js";
import type { ConsumerId, ConsumerSpec } from "./consumers.js";
import { commitSnapshot, importDotenvOutputs, readCommittedSnapshot, removeAdapterOutput, type OutputMapping, type SnapshotScope } from "./credentials.js";
import { deployCredentials, markGenerationRetired, type ConsumerDeployer, type DeploymentRecord, type ProbeRunner } from "./deployment.js";
import { planDigest, type InfraPlan } from "./planner.js";
import type { EnvironmentBinding, InfrastructureIntent, InfraEnvironment } from "./schema.js";
import type { OperationStore } from "./store.js";

/**
 * Provider credential rotation (spec §18–§19, plan P09). Rotation is modeled
 * per provider operation; unknown safety properties block issuance before any
 * provider call. Cutover and retirement are separate, evidenced facts.
 */

export type RotationProfile = Readonly<{
  /** How the provider treats the old credential when a new one is issued. */
  invalidation: "immediate" | "overlap" | "unknown";
  /** Every output the provider rotates together; null when unknown. */
  bundle: readonly string[] | null;
  /** Whether the new value can be retrieved again if the issuance response is lost. */
  reRetrieval: "proven" | "unproven";
  /** Whether a provider-specific probe can distinguish credential rejection from other failures. */
  retirementProbe: boolean;
}>;

export type RotationState =
  | "planned" | "preflight_passed" | "issuance_requested" | "new_issued" | "outcome_unknown" | "encrypted_snapshot_saved"
  | "consumers_updated" | "consumers_verified" | "old_credential_retired" | "completed"
  | "partial_cutover" | "cutover_verified_retirement_unknown" | "needs_intervention" | "blocked";

export type RotationPlan = Readonly<{
  binding: string;
  resource: string;
  resourceName: string;
  provider: string;
  outputs: readonly string[];
  consumers: readonly ConsumerId[];
  inventoryComplete: boolean;
  profile: RotationProfile;
  downtimeExpected: boolean;
  blockers: readonly string[];
  digest: string;
}>;

export class RotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RotationError";
  }
}

/**
 * Builds the rotation plan for one credential binding: the provider's actual
 * mutation unit, every affected output and consumer, and the blockers that
 * forbid unattended issuance.
 */
export function planRotation(input: { intent: InfrastructureIntent; environment: InfraEnvironment; binding: EnvironmentBinding; credentialBinding: string; profile: RotationProfile | undefined; consumers: readonly ConsumerSpec[]; inventoryComplete: boolean }): RotationPlan {
  const resources = input.intent.environments[input.environment]?.resources ?? {};
  const found = Object.entries(resources).find(([, resource]) => input.credentialBinding in resource.credentialBindings);
  if (!found) throw new RotationError(`no credential binding ${input.credentialBinding} in ${input.environment}`);
  const [resourceName, resource] = found;
  const bound = input.binding.resources[resourceName];
  if (!bound) throw new RotationError(`${resourceName} is not bound to an exact resource; rotation needs an immutable identity`);
  const blockers: string[] = [];
  const profile = input.profile ?? { invalidation: "unknown", bundle: null, reRetrieval: "unproven", retirementProbe: false };
  if (profile.invalidation === "unknown") blockers.push("provider invalidation behavior is unknown");
  if (profile.bundle === null) blockers.push("the provider's rotation unit (which outputs rotate together) is unknown");
  if (profile.invalidation === "immediate" && profile.reRetrieval !== "proven") blockers.push("immediate invalidation with an unrecoverable one-time response: a lost issuance response would leave no valid key (AR-03)");
  if (profile.invalidation === "overlap" && profile.reRetrieval !== "proven") blockers.push("an orphaned new key could not be identified after a lost response");
  if (!input.inventoryComplete) blockers.push("consumer discovery is incomplete; unknown external consumers could break");
  const declaredOutputs = Object.values(resource.credentialBindings).map((credential) => credential.output);
  const outputs = [...new Set([...(profile.bundle ?? []), ...declaredOutputs])].sort();
  const undeclared = (profile.bundle ?? []).filter((output) => !declaredOutputs.includes(output));
  if (undeclared.length) blockers.push(`rotation also replaces undeclared outputs: ${undeclared.join(", ")}`);
  const consumers = [...new Set(Object.values(resource.credentialBindings).filter((credential) => outputs.includes(credential.output)).flatMap((credential) => credential.consumers))].sort() as ConsumerId[];
  const deployed = new Set(input.consumers.map((consumer) => consumer.id));
  const unknownConsumers = consumers.filter((consumer) => !deployed.has(consumer));
  if (unknownConsumers.length) blockers.push(`consumers without a deployment target: ${unknownConsumers.join(", ")}`);
  if (profile.invalidation === "overlap") blockers.push("overlap retirement needs a provider revoke operation, which Projects 0.45.0 does not expose");
  if (profile.invalidation === "immediate" && !profile.retirementProbe) blockers.push("no provider-specific probe can prove old-key retirement");
  const body = { binding: input.credentialBinding, resource: bound.externalId, resourceName, provider: resource.provider, outputs, consumers, inventoryComplete: input.inventoryComplete, profile, downtimeExpected: profile.invalidation !== "overlap", blockers };
  return { ...body, digest: canonicalDigest(body) };
}

/**
 * Wraps a rotation plan as a digest-bound plan document, so the existing
 * approval flow binds the exact rotation unit, consumers and effects.
 */
export function rotationPlanDocument(rotation: RotationPlan, options: { environment: InfraEnvironment; binding: EnvironmentBinding; sourceDigest: string; toolchain: Toolchain | null; now: Date; ttlSeconds?: number }): InfraPlan {
  const body: Omit<InfraPlan, "digest"> = {
    schemaVersion: 1, kind: "trestle.infra.plan", environment: options.environment, sourceDigest: options.sourceDigest, toolchain: options.toolchain,
    target: { trestleProjectId: options.binding.trestleProjectId, stripeAccountId: options.binding.stripeAccountId, projectsProjectId: options.binding.projectsProjectId, projectsEnvironment: options.binding.projectsEnvironment, bindingGeneration: options.binding.generation },
    observedAt: options.now.toISOString(), stale: false,
    operations: [{
      id: `rotate-${rotation.digest.slice(7, 19)}`, resource: rotation.resourceName, classification: rotation.blockers.length ? "blocked" : "rotate", provider: rotation.provider, service: "credential", target: rotation.resource,
      dependsOn: [], effects: [...ROTATE_EFFECTS], capability: { operation: "rotate", evidence: "unknown", allowed: rotation.blockers.length === 0, reasons: [...rotation.blockers] },
      cost: { kind: "free", recurring: false, accountWide: false, requiresAuthorization: false, notes: [] }, deletionPolicy: "retain", credentialOutputs: [...rotation.outputs],
      preconditions: [`rotation unit ${rotation.digest}`, `consumers: ${rotation.consumers.join(", ") || "none"}`, rotation.downtimeExpected ? "an interruption window is approved" : "overlap retained until cutover"],
      timeoutSeconds: 300, recovery: "never issue twice; reconcile by re-retrieval; retire only after verified cutover", blockers: [...rotation.blockers],
    }],
    orphans: [], blockers: [...rotation.blockers], createdAt: options.now.toISOString(), expiresAt: new Date(options.now.getTime() + (options.ttlSeconds ?? 3600) * 1000).toISOString(),
  };
  return { ...body, digest: planDigest(body) };
}

export type RetirementEvidence = "rejected" | "accepted" | "inconclusive";

export interface RotationProbes extends ProbeRunner {
  /** True when no revision or queued work can still use the old generation marker. */
  drained(consumer: ConsumerId, oldMarker: string | null): Promise<boolean | "unknown">;
  /** Provider-specific: does the provider reject the old credential? Network/rate-limit failures are inconclusive. */
  oldCredentialRejected(provider: string, oldValue: string): Promise<RetirementEvidence>;
  /** Control check: the new credential works through the same probe path. */
  newCredentialAccepted(provider: string, newValue: string): Promise<boolean>;
}

export type RotationDeps = Readonly<{
  store: OperationStore;
  adapter: MutatingAdapter;
  workspace: string;
  projectRoot: string;
  masterKey: string;
  now: () => Date;
  deployer: ConsumerDeployer;
  probes: RotationProbes;
  consumers: readonly ConsumerSpec[];
  expectedTargets: Readonly<Partial<Record<ConsumerId, string>>>;
  artifactDigest: string;
  configDigest: string;
  outputFile: string;
  hooks?: Readonly<{ at?: (state: RotationState) => void | Promise<void> }>;
  /**
   * Operator assertion, journaled, that an earlier issuance request whose
   * re-retrieval still shows the previous value cannot complete later.
   */
  confirmNotIssued?: { actor: string; reason: string };
}>;

export type RotationResult = Readonly<{ state: RotationState; operationId: string; deployment: DeploymentRecord | null; detail: string }>;

const ROTATE_EFFECTS: readonly CommandEffect[] = ["remote_credential_issue", "remote_secret_store_write", "local_vault_write", "local_plaintext_credentials"];

/**
 * Runs or resumes one rotation operation from its journal. Never issues a
 * second credential after an unknown outcome, never retires before every
 * consumer is verified and drained, and never calls a generic failure proof.
 */
export async function rotateCredential(input: { rotation: RotationPlan; plan: InfraPlan; approval: SignedApproval; intent: InfrastructureIntent; environment: InfraEnvironment; projectId: string; scopeKey: string }, deps: RotationDeps): Promise<RotationResult> {
  const operationId = input.approval.payload.operationId;
  const transition = async (state: RotationState, data: Record<string, unknown> = {}) => {
    await deps.store.appendEvent(operationId, `infra.rotation.${state}`, { binding: input.rotation.binding, ...data }, deps.now());
    await deps.store.setOperationState(operationId, state, deps.now());
    await deps.hooks?.at?.(state);
  };
  const done = (state: RotationState, detail: string, deployment: DeploymentRecord | null = null): RotationResult => ({ state, operationId, deployment, detail });

  if (input.rotation.blockers.length) return done("blocked", input.rotation.blockers.join("; "));
  if (planDigest(input.plan) !== input.plan.digest || !input.plan.operations[0]?.preconditions.includes(`rotation unit ${input.rotation.digest}`)) return done("blocked", "the approved plan does not describe this rotation unit");
  const problems = approvalCovers(input.approval, input.plan, ROTATE_EFFECTS, deps.now());
  if (problems.length) return done("blocked", problems.join("; "));
  if (input.plan.digest !== input.approval.payload.planDigest) return done("blocked", "approval does not match the rotation plan");
  try {
    await deps.store.recordApproval(input.approval, deps.now());
  } catch (error) {
    return done("blocked", `approval rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
  const consumed = await deps.store.consumeApproval(input.approval.payload.approvalId, operationId, input.plan.digest, deps.now());
  if (consumed.status === "rejected") return done("blocked", consumed.reason);

  const resource = input.intent.environments[input.environment]!.resources[input.rotation.resourceName]!;
  const credentials = Object.entries(resource.credentialBindings).filter(([, credential]) => input.rotation.outputs.includes(credential.output));
  const purpose = credentials.every(([, credential]) => credential.classification === "operator-only") ? "operator" as const : "deployment" as const;
  if (credentials.some(([, credential]) => (credential.classification === "operator-only") !== (purpose === "operator"))) return done("blocked", "a rotation unit spanning operator-only and deployed credentials is not supported");
  const scope: SnapshotScope = { projectId: input.projectId, environment: input.environment, purpose };

  const existing = await deps.store.getOperation(operationId);
  const events = existing ? await deps.store.events(operationId) : [];
  const reached = new Set(events.map((event) => event.kind.replace("infra.rotation.", "")));
  if (!existing) await deps.store.createOperation({ id: operationId, environment: input.environment, planDigest: input.plan.digest, approvalId: input.approval.payload.approvalId, state: "planned" }, deps.now());

  const before = await readCommittedSnapshot(deps.store, scope, deps.masterKey);
  const startEvent = events.find((event) => event.kind === "infra.rotation.preflight_passed");
  const baseGeneration = startEvent ? Number(startEvent.data.baseGeneration) : before.generation;
  const oldValues = startEvent ? null : Object.fromEntries(credentials.map(([, credential]) => [credential.as ?? credential.output, before.values[credential.as ?? credential.output] ?? ""]));
  // The old value is needed later for the retirement probe; keep it encrypted under the
  // environment master key, which is independent of the credential being rotated.
  const recoveryScope: SnapshotScope = { projectId: `${input.projectId}.rotation.${operationId}`, environment: input.environment, purpose: "operator" };
  if (!reached.has("preflight_passed")) {
    if (Object.values(oldValues ?? {}).some((value) => !value)) return done("blocked", "the current credential is not in the committed snapshot; import it before rotating");
    await commitSnapshot(deps.store, recoveryScope, 0, oldValues!, Object.keys(oldValues!).map((name) => ({ name, classification: "operator-only" as const, binding: input.rotation.binding, provider: resource.provider, resource: input.rotation.resource, consumers: [], importedAt: deps.now().toISOString(), override: false })), deps.masterKey);
    await transition("preflight_passed", { baseGeneration, oldMarker: null });
  }
  const recovered = (await readCommittedSnapshot(deps.store, recoveryScope, deps.masterKey)).values;

  // Issuance: at most one provider call per operation, unless an operator confirms the earlier one never happened.
  if (!reached.has("new_issued") && !reached.has("encrypted_snapshot_saved")) {
    const mappings: OutputMapping[] = credentials.map(([name, credential]) => ({ output: credential.output, as: credential.as ?? credential.output, classification: credential.classification, binding: name, provider: resource.provider, resource: input.rotation.resource, consumers: credential.consumers }));
    const siblings = Object.entries(input.intent.environments[input.environment]!.resources).filter(([name]) => name !== input.rotation.resourceName).flatMap(([, other]) => Object.values(other.credentialBindings).map((credential) => credential.output));
    const retrieve = async () => {
      const imported = await importDotenvOutputs(deps.outputFile, deps.workspace, mappings, { projectRoot: deps.projectRoot, now: deps.now(), siblingOutputs: siblings });
      const unchanged = Object.entries(imported.values).filter(([name, value]) => before.values[name] === value).map(([name]) => name);
      return { imported, unchanged };
    };
    const issue = async (): Promise<RotationResult | undefined> => {
      const outcome = await deps.adapter.mutate("rotate", [input.rotation.resourceName], {}, deps.workspace, ROTATE_EFFECTS);
      if (outcome.status === "rejected") {
        await transition("needs_intervention", { code: outcome.code });
        return done("needs_intervention", `provider rejected rotation (${outcome.code}); no credential was issued`);
      }
      if (outcome.status === "unknown") {
        await transition("outcome_unknown", { reason: outcome.reason });
        return done("outcome_unknown", `${outcome.reason}; resume reconciles by re-retrieval, never by issuing again`);
      }
      return undefined;
    };
    let retrieved: Awaited<ReturnType<typeof retrieve>>;
    if (reached.has("issuance_requested")) {
      // A previous attempt may have issued. Recover through re-retrieval first.
      if (input.rotation.profile.reRetrieval !== "proven") return done("outcome_unknown", "issuance outcome is unknown and the value cannot be re-retrieved; manual recovery is required");
      const pulled = await deps.adapter.mutate("env pull", [], {}, deps.workspace, ["remote_read", "local_vault_write", "local_plaintext_credentials"]);
      if (pulled.status !== "ok") return done("outcome_unknown", "re-retrieval of the issued credential failed");
      retrieved = await retrieve();
      if (retrieved.unchanged.length) {
        await removeAdapterOutput(deps.outputFile);
        if (!deps.confirmNotIssued) return done("outcome_unknown", `re-retrieval still shows the previous ${retrieved.unchanged.join(", ")}; an earlier request may still complete. Once the provider confirms none is pending, resume with --confirm-not-issued`);
        await transition("issuance_requested", { confirmedNotIssuedBy: deps.confirmNotIssued.actor, reason: deps.confirmNotIssued.reason });
        const stopped = await issue();
        if (stopped) return stopped;
        retrieved = await retrieve();
      }
    } else {
      await transition("issuance_requested");
      const stopped = await issue();
      if (stopped) return stopped;
      retrieved = await retrieve();
    }
    const { imported, unchanged } = retrieved;
    if (unchanged.length) {
      await removeAdapterOutput(deps.outputFile);
      await transition("outcome_unknown", { reason: "provider returned the previous value" });
      return done("outcome_unknown", `the provider returned the previous value for ${unchanged.join(", ")}; rotation is not confirmed`);
    }
    await transition("new_issued");
    const merged = { values: { ...before.values, ...imported.values }, metadata: [...before.metadata.filter((entry) => !(entry.name in imported.values)), ...imported.metadata] };
    try {
      await commitSnapshot(deps.store, scope, before.generation, merged.values, merged.metadata, deps.masterKey);
    } finally {
      await removeAdapterOutput(deps.outputFile);
    }
    await transition("encrypted_snapshot_saved", { generation: before.generation + 1 });
  }

  const current = await readCommittedSnapshot(deps.store, scope, deps.masterKey);
  const previousEvent = (await deps.store.events(operationId)).find((event) => event.kind === "infra.rotation.preflight_passed");
  const oldGeneration = Number(previousEvent?.data.baseGeneration ?? baseGeneration);

  // Cutover: project the new generation and verify every declared consumer.
  let deployment: DeploymentRecord | null = null;
  if (purpose === "deployment") {
    deployment = await deployCredentials({ store: deps.store, scope, masterKey: deps.masterKey, consumers: deps.consumers.filter((consumer) => input.rotation.consumers.includes(consumer.id)), expectedTargets: deps.expectedTargets, deployer: deps.deployer, probes: deps.probes, artifactDigest: deps.artifactDigest, configDigest: deps.configDigest, now: deps.now });
    await transition("consumers_updated", { generation: current.generation });
    if (!deployment.verified) {
      await transition("partial_cutover", { unverified: deployment.consumers.filter((report) => report.state !== "verified").map((report) => report.consumer) });
      return done("partial_cutover", "not every consumer is verified on the new generation; the old credential is not retired", deployment);
    }
    for (const consumer of input.rotation.consumers) {
      const drained = await deps.probes.drained(consumer, null);
      if (drained !== true) {
        await transition("partial_cutover", { undrained: consumer });
        return done("partial_cutover", `${consumer} may still run work on the old generation (${drained === false ? "not drained" : "unknown"})`, deployment);
      }
    }
  }
  await transition("consumers_verified", { generation: current.generation });

  // Retirement proof: provider-specific old-key rejection plus a new-key control.
  const newValue = current.values[credentials[0]![1].as ?? credentials[0]![1].output]!;
  const oldValue = recovered[credentials[0]![1].as ?? credentials[0]![1].output];
  const control = await deps.probes.newCredentialAccepted(resource.provider, newValue);
  const evidence: RetirementEvidence = oldValue === undefined ? "inconclusive" : control ? await deps.probes.oldCredentialRejected(resource.provider, oldValue) : "inconclusive";
  if (evidence !== "rejected") {
    await transition("cutover_verified_retirement_unknown", { evidence, control });
    return done("cutover_verified_retirement_unknown", evidence === "accepted" ? "the old credential is still accepted" : "old-key retirement could not be proven (inconclusive probe or missing control)", deployment);
  }
  await markGenerationRetired(deps.store, input.projectId, input.environment, oldGeneration);
  await transition("old_credential_retired", { retiredGeneration: oldGeneration });
  await transition("completed");
  return done("completed", `rotated ${input.rotation.binding}; generation ${oldGeneration} retired`, deployment);
}
