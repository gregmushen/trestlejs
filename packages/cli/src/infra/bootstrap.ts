import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { MutatingAdapter } from "./adapters/stripe-projects.js";
import { approvalCovers, type SignedApproval } from "./approvals.js";
import { effectsOf, resolveCapability, SUPPORTED_TOOLCHAIN, type CapabilityRow, type Toolchain } from "./capabilities.js";
import { canonicalDigest } from "./canonical.js";
import { verifyPlanDigest, type InfraPlan } from "./planner.js";
import type { ApplyResult, Outcome } from "./runner.js";
import { externalIdSchema, logicalIdSchema, type EnvironmentBinding, type InfraEnvironment, type InfrastructureIntent } from "./schema.js";
import type { OperationStore } from "./store.js";
import { findCredentialLeaves, safeInfraDiagnostic } from "./redaction.js";

/** Manual creation was observed, but October 16 inspection found a native
 * retry loop without a stable idempotency key across create attempts. A single
 * wrapper invocation cannot yet guarantee one project. Keep real init blocked. */
export const PROJECT_BOOTSTRAP_CAPABILITY: CapabilityRow = {
  provider: "stripe", service: "project", operation: "create", evidence: "documented",
  toolchain: SUPPORTED_TOOLCHAIN, commands: ["init"], unknowns: ["native init retries project creation without a shared idempotency key; stable single-create behavior is not qualified"],
  observedAt: "2026-10-16T20:55:00.000Z", maxAgeDays: 30,
  limitations: ["manual mode only; no template/import/install; no provider account or resource is provisioned", "lost response is reconciled from this operation's private workspace or remains uncertain; init is never retried"],
};

export type BootstrapPlan = InfraPlan & Readonly<{ bootstrap: { applicationId: string; name: string } }>;

export function planBootstrap(input: { intent: InfrastructureIntent; environment: InfraEnvironment; applicationId: string; stripeAccountId: string; name: string; toolchain: Toolchain; now: Date; capability?: CapabilityRow }): BootstrapPlan {
  const applicationId = externalIdSchema.parse(input.applicationId);
  const name = logicalIdSchema.parse(input.name);
  if (!/^acct_[A-Za-z0-9]{6,}$/u.test(input.stripeAccountId)) throw new Error("expected an exact Stripe account ID");
  if (input.environment === "local" || !input.intent.environments[input.environment]) throw new Error("declare a remote environment before bootstrap");
  const capability = resolveCapability(input.capability ?? PROJECT_BOOTSTRAP_CAPABILITY, input.toolchain, input.now);
  const sourceDigest = canonicalDigest(input.intent);
  const pending = `pending:${canonicalDigest({ applicationId, account: input.stripeAccountId, name, environment: input.environment }).slice(7, 39)}`;
  const body = {
    schemaVersion: 1 as const, kind: "trestle.infra.plan" as const, environment: input.environment, sourceDigest,
    toolchain: input.toolchain, target: { trestleProjectId: applicationId, stripeAccountId: input.stripeAccountId, projectsProjectId: pending, projectsEnvironment: "default", bindingGeneration: 0 },
    observedAt: null, stale: false, bootstrap: { applicationId, name },
    operations: [{ id: "project-create", resource: name, classification: "create" as const, provider: "stripe", service: "project", target: pending, dependsOn: [], effects: effectsOf(["init"]), capability: { operation: "create" as const, evidence: capability.evidence, allowed: capability.allowed, reasons: capability.reasons }, cost: { kind: "free" as const, recurring: false, accountWide: false, requiresAuthorization: false, notes: ["project container only; provider services are separate operations"] }, deletionPolicy: "retain" as const, credentialOutputs: [], preconditions: ["independent control store and registered signed approval", "private empty Projects workspace; exact Stripe account explicitly selected", "no existing binding for this application/environment"], timeoutSeconds: 300, recovery: "observe the operation's workspace; never repeat init after an uncertain response", blockers: [...capability.reasons] }],
    orphans: [], blockers: [...capability.reasons], createdAt: input.now.toISOString(), expiresAt: new Date(input.now.getTime() + 3_600_000).toISOString(),
  };
  if (findCredentialLeaves(body).length) throw new Error("bootstrap plan identities must not contain credential values");
  return { ...body, digest: canonicalDigest(body) };
}

/** Journal and fence the initial project before an application has a binding.
 * The independent control store is an operator prerequisite; this never tries
 * to provision the store that governs its own creation. */
export async function applyBootstrap(input: { plan: BootstrapPlan; approval: SignedApproval; intent: InfrastructureIntent }, deps: { store: OperationStore; adapter: MutatingAdapter; workspace: string; toolchain: Toolchain; now: () => Date; simulation?: boolean; capability?: CapabilityRow }): Promise<ApplyResult> {
  const { plan, approval } = input;
  const id = approval.payload.operationId;
  const result = (outcome: Outcome, nextStep: string | null): ApplyResult => ({ outcome, operationId: id, messages: [], completed: outcome === "succeeded" ? [plan.bootstrap.name] : [], unresolved: outcome === "succeeded" ? [] : [plan.bootstrap.name], nextStep });
  if (deps.store.kind !== "postgres" && !deps.simulation) return result("blocked", "bootstrap requires an independent PostgreSQL control store");
  if (!verifyPlanDigest(plan) || !plan.target || canonicalDigest(input.intent) !== plan.sourceDigest) return result("blocked", "plan or infrastructure intent changed; re-plan");
  const evidence = deps.simulation && deps.capability ? { capability: deps.capability } : {};
  const rebuilt = planBootstrap({ intent: input.intent, environment: plan.environment, applicationId: plan.bootstrap.applicationId, stripeAccountId: plan.target.stripeAccountId, name: plan.bootstrap.name, toolchain: plan.toolchain!, now: new Date(plan.createdAt), ...evidence });
  if (rebuilt.digest !== plan.digest || canonicalDigest(plan.toolchain) !== canonicalDigest(deps.toolchain)) return result("blocked", "bootstrap plan or toolchain differs from the reviewed operation");
  const capability = resolveCapability(evidence.capability ?? PROJECT_BOOTSTRAP_CAPABILITY, deps.toolchain, deps.now());
  if (!capability.allowed || plan.blockers.length || Date.parse(plan.expiresAt) <= deps.now().getTime()) return result("blocked", "bootstrap plan or capability evidence expired or is blocked; re-plan");
  const coverage = approvalCovers(approval, plan, effectsOf(["init"]), deps.now());
  if (coverage.length) return result("blocked", coverage.join("; "));
  try { await deps.store.recordApproval(approval, deps.now()); } catch { return result("blocked", "approval is not registered, valid and authorized"); }
  const consumed = await deps.store.consumeApproval(approval.payload.approvalId, id, plan.digest, deps.now());
  if (consumed.status === "rejected") return result("blocked", consumed.reason);
  const existing = await deps.store.getOperation(id);
  if (existing && existing.planDigest !== plan.digest) return result("blocked", "operation belongs to another bootstrap plan");
  if (existing?.state === "succeeded") return result("succeeded", null);
  if (existing?.state === "failed_terminal") return result("failed_terminal", "the earlier initialization was rejected; review before creating a new operation");
  if (!existing) await deps.store.createOperation({ id, environment: plan.environment, planDigest: plan.digest, approvalId: approval.payload.approvalId, state: "running" }, deps.now());
  const bindingScope = `bindings:${plan.bootstrap.applicationId}:${plan.environment}`;
  // Serialize the application binding, not its mutable display name. Two
  // plans with different names/accounts must not create two projects for it.
  const scope = `projects-bootstrap:${plan.bootstrap.applicationId}:${plan.environment}`;
  const reserved = await deps.store.reserve(scope, id, `bootstrap-${randomUUID()}`, 600_000, deps.now());
  if (reserved.status === "busy") return result("failed_retryable", "another bootstrap holds this application/environment");
  if (reserved.status === "uncertain" && reserved.reservation.operationId !== id) return result("outcome_unknown", "another project's initialization is uncertain; reconcile it first");

  // Another process may have completed while this caller was acquiring the
  // reservation. Only state read inside this boundary can authorize init.
  const current = await deps.store.readGeneration(bindingScope);
  const events = await deps.store.events(id);
  const started = events.find((event) => event.kind === "infra.bootstrap.intent");
  const blocked = started && started.data.workspace !== path.resolve(deps.workspace)
    ? "resume must use the original private Projects workspace"
    : current && current.data.bootstrapOperation !== id
      ? "this application/environment is already bound; do not create another project" : null;
  if (blocked) {
    if (reserved.status === "acquired") await deps.store.release(scope, reserved.reservation.fencingToken);
    return result("blocked", blocked);
  }

  if (!started) {
    const hasState = await stat(path.join(deps.workspace, ".projects")).then(() => true, () => false);
    if (hasState || current || (await readdir(deps.workspace)).length > 0) {
      if (reserved.status === "acquired") await deps.store.release(scope, reserved.reservation.fencingToken);
      return result("blocked", "bootstrap requires an empty unbound Projects workspace");
    }
    if (reserved.status !== "acquired") return result("outcome_unknown", "initialization reservation is uncertain");
    const effect = `${id}:project-init`;
    await deps.store.beginEffect(scope, reserved.reservation.fencingToken, effect, deps.now());
    await deps.store.appendEvent(id, "infra.bootstrap.intent", { workspace: path.resolve(deps.workspace), stripeAccountId: plan.target.stripeAccountId, name: plan.bootstrap.name }, deps.now());
    let answer;
    try { answer = await deps.adapter.mutate("init", [plan.bootstrap.name], { account: plan.target.stripeAccountId, mode: "manual", "skip-skills": true, "skip-install": true, yes: true }, deps.workspace, approval.payload.allowedEffects); }
    catch (error) { answer = { status: "unknown" as const, reason: safeInfraDiagnostic(error) }; }
    await deps.store.appendEvent(id, "infra.bootstrap.result", { status: answer.status, ...(answer.status === "rejected" ? { code: safeInfraDiagnostic(answer.code) } : answer.status === "unknown" ? { reason: safeInfraDiagnostic(answer.reason) } : {}) }, deps.now());
    if (answer.status === "rejected") {
      await deps.store.completeEffect(scope, reserved.reservation.fencingToken, effect, deps.now());
      await deps.store.release(scope, reserved.reservation.fencingToken);
      await deps.store.setOperationState(id, "failed_terminal", deps.now());
      return result("failed_terminal", `initialization rejected (${answer.code}); no automatic retry`);
    }
    if (answer.status === "ok") {
      const receipt = externalIdSchema.safeParse((answer.data as { project?: { id?: unknown } } | undefined)?.project?.id);
      if (receipt.success) await deps.store.appendEvent(id, "infra.bootstrap.created", { projectId: receipt.data }, deps.now());
    }
    // Always leave an uncertain fence until observation and binding are durable.
    await deps.store.markUncertain(scope, reserved.reservation.fencingToken, deps.now());
  }
  const observed = await deps.adapter.observe(deps.workspace, deps.now());
  if (observed.status !== "ok") {
    await deps.store.appendEvent(id, "infra.bootstrap.observation_unavailable", { reason: safeInfraDiagnostic(observed.reason) }, deps.now());
    await deps.store.setOperationState(id, "outcome_unknown", deps.now());
    return result("outcome_unknown", "initialization may have completed; recover the original workspace and observe it, never repeat init");
  }
  const found = observed.observation;
  const receipt = (await deps.store.events(id)).find((event) => event.kind === "infra.bootstrap.created");
  if (found.stripeAccountId !== plan.target.stripeAccountId || found.projectsEnvironment !== "default" || !found.complete || found.resources.length !== 0 || found.projectsProjectId.startsWith("pending:") || (receipt && receipt.data.projectId !== found.projectsProjectId)) {
    await deps.store.setOperationState(id, "needs_intervention", deps.now());
    return result("needs_intervention", "observed account/environment/project contents differ from an empty manual project; nothing was bound");
  }
  const binding: EnvironmentBinding = { trestleProjectId: plan.bootstrap.applicationId, stripeAccountId: found.stripeAccountId, projectsProjectId: found.projectsProjectId, projectsEnvironment: found.projectsEnvironment, generation: 1, resources: {} };
  if (current && canonicalDigest(current.data.binding) !== canonicalDigest(binding)) return result("needs_intervention", "committed binding differs; no overwrite");
  if (!current) await deps.store.commitGeneration(bindingScope, 0, canonicalDigest(binding), { binding, bootstrapOperation: id });
  await deps.store.appendEvent(id, "infra.bootstrap.bound", { projectId: found.projectsProjectId }, deps.now());
  await deps.store.reconcile(scope, `observed and bound ${found.projectsProjectId}`, id, deps.now());
  await deps.store.setOperationState(id, "succeeded", deps.now());
  return result("succeeded", null);
}
