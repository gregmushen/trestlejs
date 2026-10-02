import { resolveCapability, type CapabilityRow, type CommandEffect, type EvidenceStatus, type InfraOperation, type Toolchain } from "./capabilities.js";
import { CATALOG_SERVICES, capabilityFor, DIRECT_WRITERS } from "./capability-matrix.js";
import { canonicalDigest } from "./canonical.js";
import type { DesiredResource, EnvironmentBinding, InfraEnvironment, InfrastructureBindings, InfrastructureIntent, Observation } from "./schema.js";

/**
 * Pure, deterministic infrastructure planning (spec §12, plan P02). The planner
 * performs no process, network or file access; callers persist the result.
 */

export type Classification = "no_change" | "create" | "adopt" | "configure" | "rotate" | "upgrade" | "detach" | "delete" | "blocked" | "unknown";

export type CostAssessment = Readonly<{
  /** free only when every priced catalog item involved is free; never inferred. */
  kind: "free" | "paid" | "unknown";
  recurring: boolean;
  accountWide: boolean;
  requiresAuthorization: boolean;
  limit?: Readonly<{ currency: string; monthlyMinor: number }>;
  notes: readonly string[];
}>;

export type PlanOperation = Readonly<{
  id: string;
  resource: string;
  classification: Classification;
  provider: string;
  service: string;
  plan?: string;
  /** Exact bound identity, or `pending:<operation id>` until the create is journaled. */
  target: string;
  dependsOn: readonly string[];
  effects: readonly CommandEffect[];
  capability: Readonly<{ operation: InfraOperation; evidence: EvidenceStatus; allowed: boolean; reasons: readonly string[] }>;
  cost: CostAssessment;
  deletionPolicy: "retain" | "delete";
  credentialOutputs: readonly string[];
  preconditions: readonly string[];
  timeoutSeconds: number;
  /** What happens on failure; compensation is never automatic (spec §14). */
  recovery: string;
  blockers: readonly string[];
}>;

export type InfraPlan = Readonly<{
  schemaVersion: 1;
  kind: "trestle.infra.plan";
  environment: InfraEnvironment;
  sourceDigest: string;
  toolchain: Toolchain | null;
  target: Readonly<{ trestleProjectId: string; stripeAccountId: string; projectsProjectId: string; projectsEnvironment: string; bindingGeneration: number }> | null;
  observedAt: string | null;
  stale: boolean;
  operations: readonly PlanOperation[];
  /** Bound resources no longer in intent. Reported only; never deleted by planning. */
  orphans: readonly string[];
  blockers: readonly string[];
  createdAt: string;
  expiresAt: string;
  digest: string;
}>;

export type PlanInput = Readonly<{
  intent: InfrastructureIntent;
  bindings: InfrastructureBindings;
  environment: InfraEnvironment;
  observation?: Observation;
  toolchain?: Toolchain;
  now: Date;
  /** Plans expire; apply must refresh preconditions regardless. */
  ttlSeconds?: number;
  /** Capability evidence source; defaults to the recorded matrix. Tests inject qualified rows for fake providers. */
  capabilities?: (provider: string, service: string, operation: InfraOperation) => CapabilityRow | undefined;
}>;

export class InfraPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfraPlanError";
  }
}

/** Kahn ordering with lexical tie-breaks; rejects unknown dependencies and cycles. */
export function dependencyOrder(resources: Readonly<Record<string, Pick<DesiredResource, "dependsOn">>>): string[] {
  const names = Object.keys(resources).sort();
  for (const name of names) {
    for (const dependency of resources[name]!.dependsOn) {
      if (!(dependency in resources)) throw new InfraPlanError(`${name} depends on undeclared resource ${dependency}`);
      if (dependency === name) throw new InfraPlanError(`${name} depends on itself`);
    }
  }
  const remaining = new Map(names.map((name) => [name, new Set(resources[name]!.dependsOn)]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0).map(([name]) => name).sort();
    if (ready.length === 0) throw new InfraPlanError(`dependency cycle among: ${[...remaining.keys()].sort().join(", ")}`);
    for (const name of ready) {
      order.push(name);
      remaining.delete(name);
      for (const dependencies of remaining.values()) dependencies.delete(name);
    }
  }
  return order;
}

function assessCost(resource: DesiredResource): CostAssessment {
  const catalog = CATALOG_SERVICES[resource.provider] ?? {};
  const notes: string[] = [];
  const items = [resource.service, ...(resource.plan ? [resource.plan] : [])];
  let kind: CostAssessment["kind"] = "free";
  let accountWide = false;
  let recurring = false;
  for (const item of items) {
    const service = catalog[item];
    if (!service) {
      kind = "unknown";
      notes.push(`${resource.provider}/${item} is not in the recorded catalog`);
      continue;
    }
    if (service.scope === "account") {
      accountWide = true;
      notes.push(`${resource.provider}/${item} applies to the whole provider account`);
    }
    if (service.pricing === "paid") {
      if (kind !== "unknown") kind = "paid";
      recurring = recurring || service.kind === "plan";
    } else if (service.pricing === "component") {
      // Component pricing is governed by the declared plan; without one it is unknown.
      const plan = resource.plan === undefined ? undefined : catalog[resource.plan];
      if (plan?.kind !== "plan") {
        kind = "unknown";
        notes.push(`${resource.provider}/${item} is component-priced and no catalog plan is declared`);
      }
    }
  }
  return { kind, recurring, accountWide, requiresAuthorization: kind !== "free" || accountWide, ...(resource.costLimit ? { limit: resource.costLimit } : {}), notes };
}

function identityBlockers(binding: EnvironmentBinding | undefined, observation: Observation | undefined): string[] {
  if (!binding || !observation) return [];
  const blockers: string[] = [];
  if (observation.stripeAccountId !== binding.stripeAccountId) blockers.push(`observed Stripe account ${observation.stripeAccountId} differs from bound account ${binding.stripeAccountId}`);
  if (observation.projectsProjectId !== binding.projectsProjectId) blockers.push(`observed Projects project ${observation.projectsProjectId} differs from bound project ${binding.projectsProjectId}`);
  if (observation.projectsEnvironment !== binding.projectsEnvironment) blockers.push(`observed Projects environment ${observation.projectsEnvironment} differs from bound environment ${binding.projectsEnvironment}`);
  return blockers;
}

function sharingBlockers(bindings: InfrastructureBindings, intent: InfrastructureIntent): string[] {
  const owners = new Map<string, string[]>();
  for (const [environment, binding] of Object.entries(bindings.environments)) {
    for (const [name, resource] of Object.entries(binding?.resources ?? {})) {
      const key = `${resource.provider}:${resource.externalId}`;
      owners.set(key, [...(owners.get(key) ?? []), `${environment}.${name}`]);
    }
  }
  const blockers: string[] = [];
  for (const [key, holders] of owners) {
    if (holders.length < 2) continue;
    const declared = holders.every((holder) => {
      const [environment, name] = holder.split(".") as [InfraEnvironment, string];
      const others = holders.filter((other) => other !== holder).map((other) => other.split(".")[0]);
      const shared = intent.environments[environment]?.resources[name]?.sharedWith ?? [];
      return others.every((other) => shared.includes(other as InfraEnvironment));
    });
    if (!declared) blockers.push(`resource ${key} is bound by ${holders.join(" and ")} without an explicit sharedWith declaration`);
  }
  return blockers;
}

export function planInfrastructure(input: PlanInput): InfraPlan {
  const environmentIntent = input.intent.environments[input.environment];
  if (!environmentIntent) throw new InfraPlanError(`environment ${input.environment} is not declared in .trestle/infrastructure.yaml`);
  const binding = input.bindings.environments[input.environment];
  const order = dependencyOrder(environmentIntent.resources);
  const observation = input.observation;
  const planBlockers = [...identityBlockers(binding, observation), ...sharingBlockers(input.bindings, input.intent)];
  if (!input.toolchain) planBlockers.push("Projects toolchain is unavailable or does not match the qualified executable");
  if (!binding) planBlockers.push(`environment ${input.environment} has no reviewed Projects binding; link it before mutation`);

  const operations: PlanOperation[] = order.map((name) => {
    const resource = environmentIntent.resources[name]!;
    const bound = binding?.resources[name];
    const observed = bound && observation ? observation.resources.find((candidate) => candidate.provider === bound.provider && candidate.externalId === bound.externalId) : undefined;
    const blockers: string[] = [];
    const preconditions = [
      `Stripe account and Projects project/environment match the reviewed binding for ${input.environment}`,
      "Projects plugin version and executable hash match the qualified toolchain",
    ];
    let classification: Classification;
    let operation: InfraOperation;
    let target: string;
    const id = `op-${input.environment}-${name}`;

    if (resource.lifecycleOwner !== "stripe-projects") {
      classification = "no_change";
      operation = "inspect";
      target = bound?.externalId ?? `owner:${resource.lifecycleOwner}`;
      preconditions.push(`${name} is owned by ${resource.lifecycleOwner}; Projects must not mutate it`);
    } else if (bound) {
      target = bound.externalId;
      operation = "inspect";
      if (bound.lifecycleOwner !== resource.lifecycleOwner) blockers.push(`${name} is bound to lifecycle owner ${bound.lifecycleOwner}, intent declares ${resource.lifecycleOwner}; an explicit ownership handoff is required`);
      if (bound.provider !== resource.provider || bound.service !== resource.service) blockers.push(`${name} is bound to ${bound.provider}/${bound.service}; changing service identity requires a new resource, not an in-place edit`);
      if (resource.disposition === "adopt" && resource.externalId !== bound.externalId) blockers.push(`${name} intent names ${resource.externalId} but the binding is ${bound.externalId}; bindings are immutable`);
      if (!observation) classification = "unknown";
      else if (!observed) {
        classification = "blocked";
        blockers.push(observation.complete ? `${name} (${bound.externalId}) was not found in the observed environment; investigate drift before any change` : `${name} could not be observed because discovery was incomplete`);
      } else if (observed.service !== bound.service) {
        classification = "blocked";
        blockers.push(`${name} observed service ${observed.service} differs from bound ${bound.service}`);
      } else if ((resource.plan ?? null) !== (observed.plan ?? null)) {
        classification = "upgrade";
        operation = "tier_change";
        preconditions.push(`current plan is ${observed.plan ?? "none"} immediately before apply`);
      } else classification = "no_change";
    } else if (resource.disposition === "adopt") {
      classification = "adopt";
      operation = "adopt";
      target = resource.externalId!;
      preconditions.push(`${resource.externalId} exists in the bound account with service ${resource.service}`, "the previous writer is disabled before handoff");
    } else {
      classification = "create";
      operation = "create";
      target = `pending:${id}`;
      if (observation && observation.resources.some((candidate) => candidate.provider === resource.provider && candidate.service === resource.service && candidate.name === name)) {
        blockers.push(`an unbound ${resource.provider}/${resource.service} named ${name} already exists; adopt it by exact ID or choose another name (names are not identity)`);
      }
      preconditions.push("no unresolved create operation exists for this resource");
    }

    const row = (input.capabilities ?? capabilityFor)(resource.provider, resource.service, operation);
    const resolved = row ? resolveCapability(row, input.toolchain, input.now) : undefined;
    const mutating = classification !== "no_change" && classification !== "unknown";
    if (mutating && !resolved) blockers.push(`no capability evidence for ${resource.provider}/${resource.service} ${operation}`);
    if (mutating && resolved && !resolved.allowed) blockers.push(...resolved.reasons.map((reason) => `${operation}: ${reason}`));
    for (const dependency of resource.dependsOn) {
      if (!environmentIntent.resources[dependency]) blockers.push(`missing dependency ${dependency}`);
    }
    const cost = mutating && (classification === "create" || classification === "upgrade") ? assessCost(resource) : { kind: "free" as const, recurring: false, accountWide: false, requiresAuthorization: false, notes: [] };
    if (classification === "create" || classification === "adopt") {
      const writer = DIRECT_WRITERS[`${resource.provider}/${resource.service}`];
      if (writer && resource.lifecycleOwner === "stripe-projects" && !resource.directWriterDisabled) blockers.push(`${writer}; disable it for ${input.environment} and set directWriterDisabled: true before Projects owns ${name}`);
      for (const credential of Object.values(resource.credentialBindings)) {
        const applicationConsumers = credential.consumers.filter((consumer) => consumer !== "migrations" && consumer !== "ci");
        const scopes = row?.credentialScopes ?? {};
        const scope = scopes[credential.output] ?? Object.entries(scopes).find(([pattern]) => pattern.startsWith("*") && credential.output.endsWith(pattern.slice(1)))?.[1] ?? "unknown";
        if (applicationConsumers.length && scope !== "least_privilege") blockers.push(`${credential.output} has ${scope} privilege; only a proven least-privilege credential may reach ${applicationConsumers.join(", ")} (derive a scoped runtime credential instead)`);
      }
    }
    if (cost.kind === "unknown") blockers.push(`cost of ${resource.provider}/${resource.service} is unknown and cannot be treated as free`);
    if (cost.requiresAuthorization && !resource.costLimit) blockers.push(`${name} needs a declared costLimit before a paid or account-wide change can be approved`);
    if (blockers.length > 0) classification = "blocked";

    return {
      id, resource: name, classification, provider: resource.provider, service: resource.service, ...(resource.plan ? { plan: resource.plan } : {}),
      target, dependsOn: resource.dependsOn.map((dependency) => `op-${input.environment}-${dependency}`),
      effects: resolved?.effects ?? [],
      capability: { operation, evidence: resolved?.evidence ?? "unknown", allowed: resolved?.allowed ?? false, reasons: resolved?.reasons ?? ["no capability row"] },
      cost, deletionPolicy: resource.deletionPolicy,
      credentialOutputs: Object.values(resource.credentialBindings).map((credential) => credential.as ?? credential.output).sort(),
      preconditions, timeoutSeconds: resource.timeoutSeconds,
      recovery: classification === "create" ? "on timeout, reconcile by account-scoped observation before any retry; never recreate blindly; never delete automatically" : "stop and report; resources are retained",
      blockers,
    };
  });

  const orphans = Object.keys(binding?.resources ?? {}).filter((name) => !(name in environmentIntent.resources)).sort();
  const createdAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + (input.ttlSeconds ?? 3600) * 1000).toISOString();
  const body = {
    schemaVersion: 1 as const, kind: "trestle.infra.plan" as const, environment: input.environment,
    sourceDigest: canonicalDigest(input.intent),
    toolchain: input.toolchain ?? null,
    target: binding ? { trestleProjectId: binding.trestleProjectId, stripeAccountId: binding.stripeAccountId, projectsProjectId: binding.projectsProjectId, projectsEnvironment: binding.projectsEnvironment, bindingGeneration: binding.generation } : null,
    observedAt: observation?.observedAt ?? null,
    stale: !observation,
    operations, orphans, blockers: planBlockers, createdAt, expiresAt,
  };
  return { ...body, digest: planDigest(body) };
}

/** Digest over the canonical plan without its digest field. */
export function planDigest(plan: Omit<InfraPlan, "digest"> | InfraPlan): string {
  const { digest: _digest, ...body } = plan as InfraPlan;
  return canonicalDigest(body);
}

export function verifyPlanDigest(plan: InfraPlan): boolean {
  return plan.digest === planDigest(plan);
}

export function planIsExecutable(plan: InfraPlan): boolean {
  return plan.blockers.length === 0 && !plan.stale && plan.operations.every((operation) => operation.classification !== "blocked" && operation.classification !== "unknown");
}
