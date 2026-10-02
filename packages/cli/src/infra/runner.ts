import { randomUUID } from "node:crypto";
import path from "node:path";

import type { MutatingAdapter } from "./adapters/stripe-projects.js";
import { approvalCovers, type SignedApproval } from "./approvals.js";
import type { CapabilityRow, CommandEffect, InfraOperation } from "./capabilities.js";
import { canonicalDigest } from "./canonical.js";
import { commitSnapshot, importDotenvOutputs, mergeProviderValues, readCommittedSnapshot, removeAdapterOutput, type OutputMapping, type SnapshotPurpose } from "./credentials.js";
import { planInfrastructure, verifyPlanDigest, type InfraPlan, type PlanOperation } from "./planner.js";
import type { EnvironmentBinding, InfraEnvironment, InfrastructureBindings, InfrastructureIntent, Observation } from "./schema.js";
import { StoreConflictError, type OperationStore, type Reservation } from "./store.js";

/**
 * Dependency-ordered, journaled, fenced execution of an approved plan
 * (spec §11–§14, §25; plan P06). Intent is persisted before each external
 * effect and the outcome after it. Ambiguous outcomes stop the operation and
 * leave the target reserved as uncertain; nothing is compensated automatically.
 */

export type Outcome = "succeeded" | "blocked" | "failed_retryable" | "failed_terminal" | "outcome_unknown" | "needs_intervention";

export const OUTCOME_EXIT: Readonly<Record<Outcome, number>> = { succeeded: 0, failed_terminal: 1, failed_retryable: 1, blocked: 2, outcome_unknown: 3, needs_intervention: 4 };

/** Named persistence boundaries where tests inject process termination. */
export type Boundary =
  | "before_intent" | "after_intent" | "after_begin" | "after_effect" | "after_created_event"
  | "after_binding_commit" | "after_snapshot_commit" | "after_cleanup" | "after_release";

export type RunnerDeps = Readonly<{
  store: OperationStore;
  adapter: MutatingAdapter;
  /** Isolated Projects workspace for the environment; never the application root. */
  workspace: string;
  projectRoot: string;
  masterKey: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  holder?: string;
  leaseMs?: number;
  maxAttempts?: number;
  capabilities?: (provider: string, service: string, operation: InfraOperation) => CapabilityRow | undefined;
  /** Only the in-memory store with a fake adapter may set this. */
  simulation?: boolean;
  /**
   * Operator assertion, recorded in the journal, that no earlier request for an
   * uncertain target can still complete. Absence in an observation alone never
   * proves that (AR-02).
   */
  confirmAbsent?: { actor: string; reason: string };
  /**
   * Operator override, journaled, for creating a resource although one with the
   * same name (or a `<name>-N` sibling) already exists. Projects `add` is not
   * idempotent, so the default is to refuse.
   */
  allowDuplicate?: { actor: string; reason: string };
  hooks?: Readonly<{ at?: (boundary: Boundary, context: { resource: string }) => void | Promise<void> }>;
}>;

export type ApplyInput = Readonly<{
  plan: InfraPlan;
  approval: SignedApproval;
  intent: InfrastructureIntent;
  /** Repository proposal; the control store's binding generation is authoritative. */
  bindings: InfrastructureBindings;
}>;

export type ApplyResult = Readonly<{
  outcome: Outcome;
  operationId: string;
  completed: readonly string[];
  unresolved: readonly string[];
  messages: readonly string[];
  nextStep: string | null;
}>;

const RETRYABLE_REJECTIONS = new Set(["PROVIDER_UNAVAILABLE", "RATE_LIMITED"]);

export function bindingScope(trestleProjectId: string, environment: string): string {
  return `bindings:${trestleProjectId}:${environment}`;
}

function mutationScope(binding: EnvironmentBinding): string {
  return `projects:${binding.stripeAccountId}:${binding.projectsProjectId}:${binding.projectsEnvironment}`;
}

/** Material content of a plan for drift comparison: ignores observation time, expiry and digest. */
function materialOperations(plan: InfraPlan): string {
  return canonicalDigest(plan.operations.map((operation) => ({ resource: operation.resource, classification: operation.classification, provider: operation.provider, service: operation.service, plan: operation.plan ?? null, effects: operation.effects, cost: operation.cost, credentialOutputs: operation.credentialOutputs, dependsOn: operation.dependsOn })));
}

export async function applyPlan(input: ApplyInput, deps: RunnerDeps): Promise<ApplyResult> {
  const { plan, approval, intent } = input;
  const operationId = approval.payload.operationId;
  const holder = deps.holder ?? `runner-${randomUUID()}`;
  const messages: string[] = [];
  const completed: string[] = [];
  const result = (outcome: Outcome, nextStep: string | null, unresolved: string[] = []): ApplyResult => ({ outcome, operationId, completed, unresolved, messages, nextStep });

  if (deps.store.kind !== "postgres" && !deps.simulation) return result("blocked", "configure TRESTLE_INFRA_CONTROL_DATABASE_URL with an independent PostgreSQL control store");
  if (!verifyPlanDigest(plan)) return result("blocked", "the plan file was altered; create a new plan");
  if (!plan.target) return result("blocked", "the plan has no reviewed target binding");
  if (canonicalDigest(intent) !== plan.sourceDigest) return result("blocked", "infrastructure intent changed since planning; create and approve a new plan");
  const environment = plan.environment as InfraEnvironment;
  const proposal = input.bindings.environments[environment];
  if (!proposal) return result("blocked", `no binding for ${environment}`);

  // Bindings: the control store generation wins over any repository copy (AR-04).
  const scope = bindingScope(proposal.trestleProjectId, environment);
  const committed = await deps.store.readGeneration(scope);
  const storeGeneration = committed?.generation ?? 0;
  const binding: EnvironmentBinding = committed ? (committed.data.binding as EnvironmentBinding) : proposal;
  // Only this operation's own binds may have advanced the binding since planning.
  const foreignChanges = Object.entries(binding.resources).filter(([name, bound]) => proposal.resources[name]?.externalId !== bound.externalId && bound.boundBy !== operationId);
  if (plan.target.bindingGeneration !== proposal.generation || foreignChanges.length > 0) {
    return result("blocked", "the plan was made from a stale binding generation; pull the latest bindings and re-plan");
  }

  // Fresh preconditions: observe, compare identity, and reject material drift.
  const observed = await deps.adapter.observe(deps.workspace, deps.now());
  if (observed.status !== "ok") return result("blocked", `cannot observe the target: ${observed.reason}`);
  const fresh = planInfrastructure({ intent, bindings: { ...input.bindings, environments: { ...input.bindings.environments, [environment]: binding } }, environment, observation: observed.observation, ...(plan.toolchain ? { toolchain: plan.toolchain } : {}), now: deps.now(), ...(deps.capabilities ? { capabilities: deps.capabilities } : {}) });
  if (fresh.blockers.length) return result("blocked", `refusing: ${fresh.blockers.join("; ")}`);

  const existing = await deps.store.getOperation(operationId);
  const resumable = existing ? await resumeContext(deps.store, operationId) : { bound: new Set<string>(), unknown: new Set<string>() };
  const pending = fresh.operations.filter((operation) => (operation.classification !== "no_change" || resumable.unknown.has(operation.resource)) && !resumable.bound.has(operation.resource));
  const originalPending = plan.operations.filter((operation) => operation.classification !== "no_change" && !resumable.bound.has(operation.resource));
  // A resource we created but have not yet bound shows up as an unbound same-name
  // resource; the journal identifies it, so it is not drift.
  const freshMaterial = materialOperations({ ...fresh, operations: pending.map((operation) => resumable.unknown.has(operation.resource) ? { ...operation, classification: "create", effects: plan.operations.find((original) => original.resource === operation.resource)?.effects ?? operation.effects, cost: plan.operations.find((original) => original.resource === operation.resource)?.cost ?? operation.cost } : operation) });
  if (freshMaterial !== materialOperations({ ...plan, operations: originalPending })) return result("blocked", "the target changed materially since planning; create and approve a new plan");
  const effects: CommandEffect[] = [...new Set(pending.flatMap((operation) => plan.operations.find((original) => original.resource === operation.resource)?.effects ?? operation.effects))];
  const coverage = approvalCovers(approval, plan, effects, deps.now());
  if (coverage.length) return result("blocked", `approval does not authorize this execution: ${coverage.join("; ")}`);
  const pendingBlockers = pending.flatMap((operation) => operation.blockers.filter((blocker) => !(resumable.unknown.has(operation.resource) && /names are not identity/u.test(blocker))));
  if (pendingBlockers.length) return result("blocked", `plan is not executable: ${pendingBlockers.join("; ")}`);

  // Authority: record (idempotently) and consume the approval for this operation.
  try {
    await deps.store.recordApproval(approval, deps.now());
  } catch (error) {
    return result("blocked", `approval rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
  const consumed = await deps.store.consumeApproval(approval.payload.approvalId, operationId, plan.digest, deps.now());
  if (consumed.status === "rejected") return result("blocked", `approval rejected: ${consumed.reason}`);
  if (!existing) await deps.store.createOperation({ id: operationId, environment, planDigest: plan.digest, approvalId: approval.payload.approvalId, state: "running" }, deps.now());
  await deps.store.appendEvent(operationId, existing ? "infra.apply.resumed" : "infra.apply.started", { planDigest: plan.digest, approvalId: approval.payload.approvalId, holder }, deps.now());

  const reservationScope = mutationScope(binding);
  let currentBinding = binding;
  let bindingGeneration = storeGeneration;
  for (const operation of pending) {
    if (operation.classification !== "create" && !resumable.unknown.has(operation.resource)) {
      messages.push(`${operation.resource}: ${operation.classification} is not executable in this release`);
      await deps.store.setOperationState(operationId, "needs_intervention", deps.now());
      return result("needs_intervention", `${operation.resource} requires a separately supported operation`, [operation.resource]);
    }
    const original = plan.operations.find((candidate) => candidate.resource === operation.resource) ?? operation;
    const step = await executeCreate(original, { ...deps, holder }, { operationId, reservationScope, binding: currentBinding, bindingGeneration, intent, environment, observation: observed.observation, wasUnknown: resumable.unknown.has(operation.resource) });
    messages.push(...step.messages);
    if (step.outcome !== "succeeded") {
      await deps.store.setOperationState(operationId, step.outcome, deps.now());
      if (step.outcome === "outcome_unknown") await deps.store.appendEvent(operationId, "infra.operation.recovery_required", { resource: operation.resource }, deps.now());
      return result(step.outcome, step.nextStep, [operation.resource, ...pending.slice(pending.indexOf(operation) + 1).map((later) => later.resource)]);
    }
    completed.push(operation.resource);
    currentBinding = step.binding!;
    bindingGeneration = step.bindingGeneration!;
  }
  await deps.store.setOperationState(operationId, "succeeded", deps.now());
  await deps.store.appendEvent(operationId, "infra.apply.completed", { completed }, deps.now());
  return result("succeeded", null);
}

/** `bound` holds fully completed resources; `unknown` holds started but unfinished ones. */
async function resumeContext(store: OperationStore, operationId: string): Promise<{ bound: Set<string>; unknown: Set<string> }> {
  const events = await store.events(operationId);
  const bound = new Set(events.filter((event) => event.kind === "infra.resource.completed").map((event) => String(event.data.resource)));
  const started = new Set(events.filter((event) => event.kind === "infra.effect.intent" || event.kind === "infra.resource.bound").map((event) => String(event.data.resource)));
  const unknown = new Set([...started].filter((resource) => !bound.has(resource)));
  return { bound, unknown };
}

type StepContext = Readonly<{
  operationId: string;
  reservationScope: string;
  binding: EnvironmentBinding;
  bindingGeneration: number;
  intent: InfrastructureIntent;
  environment: InfraEnvironment;
  observation: Observation;
  wasUnknown: boolean;
}>;

type StepResult = Readonly<{ outcome: Outcome; messages: string[]; nextStep: string | null; binding?: EnvironmentBinding; bindingGeneration?: number }>;

async function executeCreate(operation: PlanOperation, deps: RunnerDeps & { holder: string }, context: StepContext): Promise<StepResult> {
  const messages: string[] = [];
  const hook = async (boundary: Boundary) => deps.hooks?.at?.(boundary, { resource: operation.resource });
  const resource = context.intent.environments[context.environment]!.resources[operation.resource]!;
  // Longer than the adapter's 300s mutation timeout, so a slow call cannot outlive its lease unnoticed.
  const leaseMs = deps.leaseMs ?? 600_000;

  let reservation: Reservation;
  const reserved = await deps.store.reserve(context.reservationScope, context.operationId, deps.holder, leaseMs, deps.now());
  if (reserved.status === "busy") return { outcome: "failed_retryable", messages, nextStep: `another runner (${reserved.holder}) holds the target until ${reserved.leaseExpiresAt}` };
  if (reserved.status === "uncertain") {
    // Reconcile the in-flight uncertainty by observation before anything else.
    const match = context.observation.resources.find((candidate) => candidate.provider === resource.provider && candidate.service === resource.service && candidate.name === operation.resource);
    const alreadyBound = Object.values(context.binding.resources).some((bound) => bound.externalId === match?.externalId);
    if (match && !alreadyBound && context.wasUnknown) {
      await deps.store.reconcile(context.reservationScope, `observed ${match.externalId} created by ${context.operationId}`, deps.holder, deps.now());
      messages.push(`${operation.resource}: reconciled earlier uncertain create as ${match.externalId}`);
      const again = await deps.store.reserve(context.reservationScope, context.operationId, deps.holder, leaseMs, deps.now());
      if (again.status !== "acquired") return { outcome: "failed_retryable", messages, nextStep: "target became busy during reconciliation; retry" };
      return finishCreate(operation, match.externalId, again.reservation, deps, context, messages);
    }
    if (!match && context.observation.complete && context.wasUnknown && deps.confirmAbsent) {
      await deps.store.reconcile(context.reservationScope, `operator ${deps.confirmAbsent.actor} confirmed no request can complete: ${deps.confirmAbsent.reason}`, deps.confirmAbsent.actor, deps.now());
      messages.push(`${operation.resource}: earlier uncertain create left no resource; retrying`);
      const again = await deps.store.reserve(context.reservationScope, context.operationId, deps.holder, leaseMs, deps.now());
      if (again.status !== "acquired") return { outcome: "failed_retryable", messages, nextStep: "target became busy during reconciliation; retry" };
      reservation = again.reservation;
    } else {
      return { outcome: "outcome_unknown", messages, nextStep: match || !context.wasUnknown
        ? `target ${context.reservationScope} is uncertain and cannot be identified automatically; inspect the provider before resuming`
        : `no ${operation.resource} is visible yet, but an earlier request may still complete; once the provider confirms none is pending, run trestle infra operation resume ${context.operationId} --confirm-absent` };
    }
  } else {
    reservation = reserved.reservation;
  }

  // A resource from an earlier interrupted attempt of this operation: already bound, or found by observation.
  const alreadyBound = context.binding.resources[operation.resource];
  if (context.wasUnknown && alreadyBound?.boundBy === context.operationId) return finishCreate(operation, alreadyBound.externalId, reservation, deps, context, messages);
  if (context.wasUnknown) {
    const match = context.observation.resources.find((candidate) => candidate.provider === resource.provider && candidate.service === resource.service && candidate.name === operation.resource);
    if (match) return finishCreate(operation, match.externalId, reservation, deps, context, messages);
    if (!context.observation.complete) {
      await deps.store.markUncertain(context.reservationScope, reservation.fencingToken, deps.now());
      return { outcome: "outcome_unknown", messages, nextStep: "discovery was incomplete; an earlier create cannot be ruled out" };
    }
  }

  const maxAttempts = deps.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const effectId = `${context.operationId}:${operation.resource}:create:${attempt}`;
    // Last-moment duplicate check while holding the reservation: another writer
    // (dashboard, raw CLI) may have created the name since planning.
    const fresh = await deps.adapter.observe(deps.workspace, deps.now());
    if (fresh.status !== "ok") {
      await deps.store.release(context.reservationScope, reservation.fencingToken);
      return { outcome: "failed_retryable", messages, nextStep: `cannot re-check for duplicates before creating ${operation.resource}: ${fresh.reason}` };
    }
    const sibling = new RegExp(`^${operation.resource.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:-\\d+)?$`, "u");
    const duplicates = fresh.observation.resources.filter((candidate) => candidate.provider === resource.provider && candidate.service === resource.service && candidate.name !== undefined && sibling.test(candidate.name));
    if (duplicates.length && !deps.allowDuplicate) {
      await deps.store.release(context.reservationScope, reservation.fencingToken);
      return { outcome: "needs_intervention", messages: [...messages, `${operation.resource}: ${duplicates.map((candidate) => `${candidate.name} (${candidate.externalId})`).join(", ")} already exists`], nextStep: `Projects add is not idempotent and would create another ${resource.provider}/${resource.service}. Adopt or remove the existing resource, or rerun with --allow-duplicate <reason> --actor <name> if a second one is intended` };
    }
    // Projects requires the declared plan before a service; provision it first as its own fenced effect.
    if (resource.plan && !fresh.observation.plans.some((plan) => plan.provider === resource.provider && plan.service === resource.plan)) {
      const planEffect = `${context.operationId}:${operation.resource}:plan:${attempt}`;
      await deps.store.appendEvent(context.operationId, "infra.effect.intent", { resource: operation.resource, effectId: planEffect, command: "add", plan: resource.plan }, deps.now());
      await deps.store.beginEffect(context.reservationScope, reservation.fencingToken, planEffect, deps.now());
      const planOutcome = await deps.adapter.mutate("add", [`${resource.provider}/${resource.plan}`], {}, deps.workspace, [...new Set(operation.effects)]);
      if (planOutcome.status === "unknown") {
        await deps.store.markUncertain(context.reservationScope, reservation.fencingToken, deps.now()).catch(() => undefined);
        await deps.store.appendEvent(context.operationId, "infra.effect.outcome_unknown", { resource: operation.resource, effectId: planEffect, reason: planOutcome.reason }, deps.now());
        return { outcome: "outcome_unknown", messages: [...messages, `${operation.resource}: plan ${resource.plan}: ${planOutcome.reason}`], nextStep: `run trestle infra operation resume ${context.operationId}` };
      }
      reservation = await deps.store.completeEffect(context.reservationScope, reservation.fencingToken, planEffect, deps.now());
      if (planOutcome.status === "rejected" && RETRYABLE_REJECTIONS.has(planOutcome.code) && attempt < maxAttempts) {
        await deps.sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
        continue;
      }
      if (planOutcome.status === "rejected") {
        await deps.store.release(context.reservationScope, reservation.fencingToken);
        return { outcome: "needs_intervention", messages: [...messages, `${operation.resource}: provider rejected plan ${resource.plan} (${planOutcome.code}): ${planOutcome.message}`], nextStep: "resolve the plan problem, then resume" };
      }
      await deps.store.appendEvent(context.operationId, "infra.plan.provisioned", { resource: operation.resource, plan: resource.plan }, deps.now());
    }
    if (duplicates.length) await deps.store.appendEvent(context.operationId, "infra.duplicate.allowed", { resource: operation.resource, existing: duplicates.map((candidate) => candidate.externalId), actor: deps.allowDuplicate!.actor, reason: deps.allowDuplicate!.reason }, deps.now());
    await hook("before_intent");
    await deps.store.appendEvent(context.operationId, "infra.effect.intent", { resource: operation.resource, effectId, command: "add" }, deps.now());
    await hook("after_intent");
    await deps.store.beginEffect(context.reservationScope, reservation.fencingToken, effectId, deps.now());
    await hook("after_begin");
    const outcome = await deps.adapter.mutate("add", [`${resource.provider}/${resource.service}`], { name: operation.resource }, deps.workspace, [...new Set(operation.effects)]);
    await hook("after_effect");
    if (outcome.status === "unknown") {
      // Leave the effect in flight: the reservation stays fenced and uncertain.
      await deps.store.markUncertain(context.reservationScope, reservation.fencingToken, deps.now()).catch(() => undefined);
      await deps.store.appendEvent(context.operationId, "infra.effect.outcome_unknown", { resource: operation.resource, effectId, reason: outcome.reason }, deps.now());
      return { outcome: "outcome_unknown", messages: [...messages, `${operation.resource}: ${outcome.reason}`], nextStep: `run trestle infra operation resume ${context.operationId} to reconcile by observation; never retry blindly` };
    }
    reservation = await deps.store.completeEffect(context.reservationScope, reservation.fencingToken, effectId, deps.now());
    if (outcome.status === "rejected") {
      await deps.store.appendEvent(context.operationId, "infra.effect.rejected", { resource: operation.resource, effectId, code: outcome.code }, deps.now());
      if (!RETRYABLE_REJECTIONS.has(outcome.code) || attempt === maxAttempts) {
        await deps.store.release(context.reservationScope, reservation.fencingToken);
        const terminal = !RETRYABLE_REJECTIONS.has(outcome.code);
        return { outcome: terminal ? "needs_intervention" : "failed_retryable", messages: [...messages, `${operation.resource}: provider rejected create (${outcome.code}): ${outcome.message}`], nextStep: terminal ? "resolve the provider-reported problem, then resume" : "retry later; attempts are exhausted for this run" };
      }
      await deps.sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
      const renewed = await deps.store.reserve(context.reservationScope, context.operationId, deps.holder, leaseMs, deps.now());
      if (renewed.status !== "acquired") return { outcome: "outcome_unknown", messages, nextStep: "lost the reservation between attempts" };
      reservation = renewed.reservation;
      continue;
    }
    const externalId = extractResourceId(outcome.data);
    if (!externalId) {
      await deps.store.markUncertain(context.reservationScope, reservation.fencingToken, deps.now());
      return { outcome: "outcome_unknown", messages: [...messages, `${operation.resource}: create succeeded without a resource identity`], nextStep: `run trestle infra operation resume ${context.operationId}` };
    }
    await deps.store.appendEvent(context.operationId, "infra.resource.created", { resource: operation.resource, externalId }, deps.now());
    await hook("after_created_event");
    return finishCreate(operation, externalId, reservation, deps, context, messages);
  }
  return { outcome: "failed_retryable", messages, nextStep: "attempts exhausted" };
}

/** The created resource identity: `data.service.key` at plugin 0.45.0 (observed 2026-10-02). */
function extractResourceId(data: unknown): string | undefined {
  const id = (data as { service?: { key?: unknown } } | undefined)?.service?.key;
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u.test(id) ? id : undefined;
}

async function finishCreate(operation: PlanOperation, externalId: string, reservation: Reservation, deps: RunnerDeps & { holder: string }, context: StepContext, messages: string[]): Promise<StepResult> {
  const hook = async (boundary: Boundary) => deps.hooks?.at?.(boundary, { resource: operation.resource });
  const resource = context.intent.environments[context.environment]!.resources[operation.resource]!;

  // Bind the exact identity by compare-and-swap on the binding generation.
  const scope = bindingScope(context.binding.trestleProjectId, context.environment);
  const current = await deps.store.readGeneration(scope);
  const base: EnvironmentBinding = current ? (current.data.binding as EnvironmentBinding) : context.binding;
  let binding: EnvironmentBinding;
  let generation = current?.generation ?? 0;
  const existing = base.resources[operation.resource];
  if (existing && existing.externalId !== externalId) {
    await deps.store.markUncertain(context.reservationScope, reservation.fencingToken, deps.now());
    return { outcome: "needs_intervention", messages, nextStep: `${operation.resource} is already bound to ${existing.externalId}; ${externalId} needs manual review` };
  }
  if (existing) {
    binding = base;
  } else {
    binding = { ...base, generation: base.generation + 1, resources: { ...base.resources, [operation.resource]: { provider: resource.provider, service: resource.service, ...(resource.plan ? { plan: resource.plan } : {}), externalId, lifecycleOwner: "stripe-projects", boundBy: context.operationId } } };
    generation = (await deps.store.commitGeneration(scope, generation, canonicalDigest(binding), { binding })).generation;
  }
  await hook("after_binding_commit");
  await deps.store.appendEvent(context.operationId, "infra.resource.bound", { resource: operation.resource, externalId, bindingGeneration: binding.generation }, deps.now());

  // Import declared credentials into encrypted, generation-bound snapshots.
  const declared = Object.entries(resource.credentialBindings);
  if (declared.length) {
    const pulled = await deps.adapter.mutate("env pull", [], {}, deps.workspace, ["remote_read", "local_vault_write", "local_plaintext_credentials"]);
    if (pulled.status !== "ok") {
      await deps.store.release(context.reservationScope, reservation.fencingToken);
      await deps.store.appendEvent(context.operationId, "infra.credentials.import_failed", { resource: operation.resource }, deps.now());
      return { outcome: "needs_intervention", messages: [...messages, `${operation.resource}: credential pull did not complete`], nextStep: "the resource is bound and retained; rerun credential import" };
    }
    const outputFile = path.join(deps.workspace, context.binding.projectsEnvironment === "default" ? ".env" : `.env.${context.binding.projectsEnvironment}`);
    const environmentResources = context.intent.environments[context.environment]!.resources;
    const siblingOutputs = [...context.intent.environments[context.environment]!.ignoredOutputs, ...Object.entries(environmentResources).filter(([name]) => name !== operation.resource).flatMap(([, other]) => Object.values(other.credentialBindings).map((credential) => credential.output))];
    for (const purpose of ["operator", "deployment"] as SnapshotPurpose[]) {
      const mappings: OutputMapping[] = declared.filter(([, credential]) => (credential.classification === "operator-only") === (purpose === "operator")).map(([name, credential]) => ({ output: credential.output, as: credential.as ?? credential.output, classification: credential.classification, binding: name, provider: resource.provider, resource: externalId, consumers: credential.consumers }));
      if (!mappings.length) continue;
      const otherPurpose = declared.filter(([, credential]) => (credential.classification === "operator-only") !== (purpose === "operator")).map(([, credential]) => credential.output);
      const imported = await importDotenvOutputs(outputFile, deps.workspace, mappings, { projectRoot: deps.projectRoot, now: deps.now(), siblingOutputs: [...siblingOutputs, ...otherPurpose] });
      const snapshotScope = { projectId: context.binding.trestleProjectId, environment: context.environment, purpose };
      const committedSnapshot = await readCommittedSnapshot(deps.store, snapshotScope, deps.masterKey);
      const merged = mergeProviderValues(committedSnapshot, imported);
      if (merged.status === "conflict") {
        await deps.store.release(context.reservationScope, reservation.fencingToken);
        return { outcome: "needs_intervention", messages: [...messages, ...merged.conflicts], nextStep: "resolve credential override conflicts, then resume" };
      }
      await commitSnapshot(deps.store, snapshotScope, committedSnapshot.generation, merged.values, merged.metadata, deps.masterKey);
    }
    await hook("after_snapshot_commit");
    const cleanup = await removeAdapterOutput(outputFile);
    if (!cleanup.removed) await deps.store.appendEvent(context.operationId, "infra.cleanup.debt", { resource: operation.resource, detail: cleanup.debt ?? "" }, deps.now());
    await hook("after_cleanup");
    await deps.store.appendEvent(context.operationId, "infra.credentials.imported", { resource: operation.resource, names: declared.map(([, credential]) => credential.as ?? credential.output).sort() }, deps.now());
  }
  await deps.store.appendEvent(context.operationId, "infra.resource.completed", { resource: operation.resource, externalId }, deps.now());
  try {
    await deps.store.release(context.reservationScope, reservation.fencingToken);
  } catch (error) {
    if (!(error instanceof StoreConflictError)) throw error;
    // Another runner marked the target uncertain after our lease lapsed; the resource is bound, but the reservation needs explicit reconciliation.
    await deps.store.appendEvent(context.operationId, "infra.operation.recovery_required", { resource: operation.resource, reason: error.message }, deps.now());
    return { outcome: "needs_intervention", messages: [...messages, `${operation.resource}: bound ${externalId}, but the target reservation was marked uncertain by another runner`], nextStep: "reconcile the reservation, then resume" };
  }
  await hook("after_release");
  messages.push(`${operation.resource}: created and bound ${externalId}`);
  return { outcome: "succeeded", messages, nextStep: null, binding, bindingGeneration: generation };
}
