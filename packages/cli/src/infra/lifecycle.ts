import type { CapabilityRow, InfraOperation } from "./capabilities.js";
import { resolveCapability, type Toolchain } from "./capabilities.js";
import { capabilityFor } from "./capability-matrix.js";
import { canonicalDigest } from "./canonical.js";
import type { DesiredResource, EnvironmentBinding, InfrastructureIntent, InfraEnvironment, Observation } from "./schema.js";

/**
 * Adoption, tier changes, detach and destruction planning (spec §14, §22–§23,
 * plan P13). Every plan names exact identities and its safeguards; destructive
 * and non-destructive operations are never aliases of each other.
 */

export type LifecycleKind = "adopt" | "tier_change" | "detach" | "destroy";

export type LifecyclePlan = Readonly<{
  kind: LifecycleKind;
  environment: InfraEnvironment;
  resource: string;
  provider: string;
  service: string;
  /** The exact external identity the operation is bound to. */
  externalId: string;
  destructive: boolean;
  safeguards: readonly string[];
  blockers: readonly string[];
  digest: string;
}>;

export type DestroyEvidence = Readonly<{
  /** Consumers still referencing the resource, from a complete reference scan. */
  consumers: readonly string[];
  referenceScanComplete: boolean;
  /** A tested restore (not merely an existing backup), where recovery is required. */
  restoreVerified: boolean;
  /** Active work drained (queues, jobs, connections). */
  drained: boolean;
}>;

type Resolve = (provider: string, service: string, operation: InfraOperation) => CapabilityRow | undefined;

function capabilityBlockers(resource: Pick<DesiredResource, "provider" | "service">, operation: InfraOperation, toolchain: Toolchain | undefined, now: Date, resolve: Resolve = capabilityFor): string[] {
  const row = resolve(resource.provider, resource.service, operation);
  if (!row) return [`no capability evidence for ${resource.provider}/${resource.service} ${operation}`];
  const resolved = resolveCapability(row, toolchain, now);
  return resolved.allowed ? [] : resolved.reasons.map((reason) => `${operation}: ${reason}`);
}

function finish(body: Omit<LifecyclePlan, "digest">): LifecyclePlan {
  return { ...body, digest: canonicalDigest(body) };
}

function observedById(observation: Observation | undefined, provider: string, externalId: string) {
  return observation?.resources.find((candidate) => candidate.provider === provider && candidate.externalId === externalId);
}

/**
 * Adoption binds an existing resource by exact identity, verified in the bound
 * account and environment. A display-name match is never sufficient, and the
 * previous writer must be named and disabled.
 */
export function planAdopt(input: { intent: InfrastructureIntent; environment: InfraEnvironment; binding: EnvironmentBinding; resource: string; observation?: Observation; previousWriter: string | null; toolchain?: Toolchain; now: Date; capabilities?: Resolve }): LifecyclePlan {
  const desired = input.intent.environments[input.environment]?.resources[input.resource];
  if (!desired) throw new Error(`${input.resource} is not declared in ${input.environment}`);
  const blockers: string[] = [];
  if (desired.disposition !== "adopt" || !desired.externalId) blockers.push("adoption requires disposition: adopt with an exact externalId in intent");
  const externalId = desired.externalId ?? "(none)";
  if (input.binding.resources[input.resource]) blockers.push(`${input.resource} is already bound to ${input.binding.resources[input.resource]!.externalId}`);
  const duplicate = Object.entries(input.binding.resources).find(([, bound]) => bound.externalId === externalId && bound.provider === desired.provider);
  if (duplicate) blockers.push(`${externalId} is already bound as ${duplicate[0]}; one resource cannot be adopted twice`);
  if (!input.observation) blockers.push("no fresh observation of the bound account; adoption must verify the identity first");
  else {
    const found = observedById(input.observation, desired.provider, externalId);
    if (!found) blockers.push(`${externalId} was not found in the bound account and environment`);
    else if (found.service !== desired.service) blockers.push(`${externalId} is ${found.service}, not ${desired.service}`);
    if (input.observation.stripeAccountId !== input.binding.stripeAccountId || input.observation.projectsProjectId !== input.binding.projectsProjectId) blockers.push("observation is from a different account or project than the binding");
  }
  if (!input.previousWriter) blockers.push("name the previous writer (for example a generated direct-provider script) so it can be disabled before handoff");
  blockers.push(...capabilityBlockers(desired, "adopt", input.toolchain, input.now, input.capabilities));
  return finish({
    kind: "adopt", environment: input.environment, resource: input.resource, provider: desired.provider, service: desired.service, externalId, destructive: false,
    safeguards: ["no recreation, credential replacement, data import or migration rewrite", `disable previous writer: ${input.previousWriter ?? "(unnamed)"}`, "bind only after identity, region and service are verified"],
    blockers,
  });
}

/** Tier changes refresh price and account-wide effect; downgrades are classified as potentially destructive. */
export function planTierChange(input: { intent: InfrastructureIntent; environment: InfraEnvironment; binding: EnvironmentBinding; resource: string; targetPlan: string; currentPlan: string | null; price: { currency: string; monthlyMinor: number | null; accountWide: boolean } | null; direction: "upgrade" | "downgrade"; toolchain?: Toolchain; now: Date; capabilities?: Resolve }): LifecyclePlan {
  const desired = input.intent.environments[input.environment]?.resources[input.resource];
  const bound = input.binding.resources[input.resource];
  if (!desired || !bound) throw new Error(`${input.resource} must be declared and bound before a tier change`);
  const blockers: string[] = [];
  if (!input.currentPlan) blockers.push("current plan was not observed immediately before planning");
  if (!input.price || input.price.monthlyMinor === null) blockers.push("current price is unknown; unknown cost is never treated as free");
  if (input.price && desired.costLimit && input.price.monthlyMinor !== null && (input.price.currency !== desired.costLimit.currency || input.price.monthlyMinor > desired.costLimit.monthlyMinor)) blockers.push(`price ${input.price.monthlyMinor} ${input.price.currency} exceeds the declared cost limit`);
  if (input.price && input.price.monthlyMinor !== null && input.price.monthlyMinor > 0 && !desired.costLimit) blockers.push("a paid tier needs a declared costLimit");
  if (input.price?.accountWide) blockers.push("the plan applies to the whole provider account; approve the account-wide effect explicitly");
  blockers.push(...capabilityBlockers(desired, "tier_change", input.toolchain, input.now, input.capabilities));
  return finish({
    kind: "tier_change", environment: input.environment, resource: input.resource, provider: desired.provider, service: desired.service, externalId: bound.externalId,
    destructive: input.direction === "downgrade",
    // Tiers are always provider-qualified so they cannot be confused with the application's Starter/Pro/Business plans.
    safeguards: [`change ${desired.provider}/${input.currentPlan ?? "unknown"} → ${desired.provider}/${input.targetPlan}`, "no automatic paid change after a failed health check", "customer billing products and entitlements are not touched", ...(input.direction === "downgrade" ? ["downgrade may remove capacity or data; treated as destructive"] : [])],
    blockers,
  });
}

/** Detach keeps the resource. Projects 0.45.0 offers no proven non-destructive detach, so this stays blocked rather than calling remove. */
export function planDetach(input: { environment: InfraEnvironment; binding: EnvironmentBinding; resource: string; intent: InfrastructureIntent; toolchain?: Toolchain; now: Date; capabilities?: Resolve }): LifecyclePlan {
  const desired = input.intent.environments[input.environment]?.resources[input.resource];
  const bound = input.binding.resources[input.resource];
  if (!desired || !bound) throw new Error(`${input.resource} must be declared and bound to detach`);
  return finish({
    kind: "detach", environment: input.environment, resource: input.resource, provider: desired.provider, service: desired.service, externalId: bound.externalId, destructive: false,
    safeguards: ["the provider resource and its data are retained", "never implemented with a deleting provider command", "credentials are reconciled separately; local file removal is not revocation"],
    blockers: capabilityBlockers(desired, "detach", input.toolchain, input.now, input.capabilities),
  });
}

/**
 * Destruction targets the bound exact ID, honors retain policy, requires a
 * complete reference scan, drained consumers and verified restore, and refuses
 * when the name now resolves to a different resource (AR-11).
 */
export function planDestroy(input: { intent: InfrastructureIntent; environment: InfraEnvironment; binding: EnvironmentBinding; resource: string; observation?: Observation; evidence: DestroyEvidence; confirmTarget: string | null; toolchain?: Toolchain; now: Date; capabilities?: Resolve }): LifecyclePlan {
  const desired = input.intent.environments[input.environment]?.resources[input.resource];
  const bound = input.binding.resources[input.resource];
  if (!bound) throw new Error(`${input.resource} is not bound; there is no exact identity to destroy`);
  const provider = bound.provider;
  const service = bound.service;
  const blockers: string[] = [];
  if (desired && desired.deletionPolicy !== "delete") blockers.push(`${input.resource} has deletionPolicy ${desired.deletionPolicy}; change it to delete in reviewed source first`);
  if (input.confirmTarget !== bound.externalId) blockers.push(`confirm the exact target ID (${bound.externalId}); names are not accepted`);
  if (!input.evidence.referenceScanComplete) blockers.push("reference discovery is incomplete; deletion is blocked");
  if (input.evidence.consumers.length) blockers.push(`still referenced by: ${input.evidence.consumers.join(", ")}`);
  if (!input.evidence.drained) blockers.push("active work has not been drained");
  if (!input.evidence.restoreVerified) blockers.push("no verified restore; a backup-exists flag is not restore evidence");
  if (!input.observation) blockers.push("no fresh observation; resumed deletion must recheck identity");
  else {
    const byId = observedById(input.observation, provider, bound.externalId);
    const byName = input.observation.resources.find((candidate) => candidate.provider === provider && candidate.name === input.resource);
    if (!byId) blockers.push(`${bound.externalId} no longer exists; reconcile the binding instead of deleting`);
    if (byName && byName.externalId !== bound.externalId) blockers.push(`the name ${input.resource} now resolves to ${byName.externalId}, a replacement; it will not be deleted`);
  }
  if (input.environment === "production" && !input.confirmTarget) blockers.push("production deletion requires explicit target confirmation and independent authorization");
  blockers.push(...capabilityBlockers({ provider, service }, "delete", input.toolchain, input.now, input.capabilities));
  return finish({
    kind: "destroy", environment: input.environment, resource: input.resource, provider, service, externalId: bound.externalId, destructive: true,
    safeguards: ["stop new consumers, drain work, verify restore, recheck identity and references, then delete by exact ID", "afterwards reconcile snapshots, host bindings and Projects state; failures remain open items", "never deleted because a manifest entry disappeared"],
    blockers,
  });
}
