import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StripeProjectsAdapter } from "./adapters/stripe-projects.js";
import { approvalCovers, type SignedApproval } from "./approvals.js";
import { effectsOf, resolveCapability, type CapabilityRow, type Toolchain } from "./capabilities.js";
import { canonicalDigest } from "./canonical.js";
import { capabilityFor } from "./capability-matrix.js";
import { verifyPlanDigest, type InfraPlan } from "./planner.js";
import type { ApplyResult, Outcome } from "./runner.js";
import type { EnvironmentBinding, InfraEnvironment, InfrastructureIntent } from "./schema.js";
import type { OperationStore } from "./store.js";
import { findCredentialLeaves } from "./redaction.js";

export type ProviderLinkPlan = InfraPlan & { providerLink: { provider: "neon" | "cloudflare"; allowAccountCreation: boolean; acceptTerms: boolean } };

/** Linking is an account-level grant, not service creation. The pinned plugin
 * cannot promise existing-only linking, so that request always stays blocked. */
export function planProviderLink(input: { intent: InfrastructureIntent; binding: EnvironmentBinding; environment: InfraEnvironment; provider: "neon" | "cloudflare"; allowAccountCreation: boolean; acceptTerms: boolean; toolchain: Toolchain; now: Date; capability?: CapabilityRow }): ProviderLinkPlan {
  const service = input.provider === "neon" ? "postgres" : "workers";
  const row = input.capability ?? capabilityFor(input.provider, service, "link")!;
  const capability = resolveCapability(row, input.toolchain, input.now);
  const blockers = [...capability.reasons, ...(!input.allowAccountCreation ? ["the pinned provider link can create an account; existing-account-only selection is not proven; separately approve --allow-account-creation or leave this blocked"] : [])];
  const effects = [...effectsOf(["link"]), ...(input.acceptTerms ? ["remote_terms_acceptance" as const] : [])];
  const providerLink = { provider: input.provider, allowAccountCreation: input.allowAccountCreation, acceptTerms: input.acceptTerms };
  const body = {
    schemaVersion: 1 as const, kind: "trestle.infra.plan" as const, environment: input.environment, sourceDigest: canonicalDigest(input.intent), toolchain: input.toolchain,
    target: { trestleProjectId: input.binding.trestleProjectId, stripeAccountId: input.binding.stripeAccountId, projectsProjectId: input.binding.projectsProjectId, projectsEnvironment: input.binding.projectsEnvironment, bindingGeneration: input.binding.generation },
    providerLink, observedAt: null, stale: false, orphans: [], blockers,
    operations: [{ id: "provider-link", resource: input.provider, classification: "configure" as const, provider: input.provider, service, target: input.binding.projectsProjectId, dependsOn: [], effects, capability: { operation: "link" as const, evidence: capability.evidence, allowed: capability.allowed && blockers.length === 0, reasons: blockers }, cost: { kind: "unknown" as const, recurring: false, accountWide: true, requiresAuthorization: true, limit: { currency: "usd", monthlyMinor: 0 }, notes: ["account authorization may create a provider account; no service or paid plan is authorized", "zero-dollar approval is not a provider spend cap"] }, deletionPolicy: "retain" as const, credentialOutputs: [], preconditions: ["registered signed account-grant approval", "fresh exact project/account/environment observation", "provider account creation explicitly authorized"], timeoutSeconds: 300, recovery: "observe provider authorization in the same workspace; never reissue an uncertain grant", blockers }],
    createdAt: input.now.toISOString(), expiresAt: new Date(input.now.getTime() + 3_600_000).toISOString(),
  };
  if (findCredentialLeaves(body).length) throw new Error("provider grant plan identities must not contain credential values");
  return { ...body, digest: canonicalDigest(body) };
}

const providerStatus = z.object({ project: z.object({ id: z.string(), merchant_id: z.string() }).passthrough(), active_environment: z.string(), providers: z.array(z.object({ name: z.string(), account_request_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u), status: z.string() }).passthrough()) }).passthrough();

export async function applyProviderLink(input: { plan: ProviderLinkPlan; approval: SignedApproval; intent: InfrastructureIntent; binding: EnvironmentBinding }, deps: { store: OperationStore; adapter: Pick<StripeProjectsAdapter, "mutate" | "observe" | "read">; workspace: string; toolchain: Toolchain; now: () => Date; simulation?: boolean; capability?: CapabilityRow }): Promise<ApplyResult> {
  const { plan, approval, binding } = input;
  const id = approval.payload.operationId;
  const provider = plan.providerLink.provider;
  const result = (outcome: Outcome, nextStep: string | null): ApplyResult => ({ outcome, operationId: id, messages: [], completed: outcome === "succeeded" ? [provider] : [], unresolved: outcome === "succeeded" ? [] : [provider], nextStep });
  if (deps.store.kind !== "postgres" && !deps.simulation) return result("blocked", "provider grants require an independent PostgreSQL control store");
  if (!verifyPlanDigest(plan) || canonicalDigest(input.intent) !== plan.sourceDigest || canonicalDigest(plan.toolchain) !== canonicalDigest(deps.toolchain)) return result("blocked", "source, plan or toolchain drift");
  const evidence = deps.simulation && deps.capability ? { capability: deps.capability } : {};
  const rebuilt = planProviderLink({ intent: input.intent, binding, environment: plan.environment, ...plan.providerLink, toolchain: deps.toolchain, now: new Date(plan.createdAt), ...evidence });
  const fresh = planProviderLink({ intent: input.intent, binding, environment: plan.environment, ...plan.providerLink, toolchain: deps.toolchain, now: deps.now(), ...evidence });
  if (rebuilt.digest !== plan.digest || fresh.blockers.length || Date.parse(plan.expiresAt) <= deps.now().getTime()) return result("blocked", "provider grant is blocked, expired or targets a changed binding");
  const observed = await deps.adapter.observe(deps.workspace, deps.now());
  if (observed.status !== "ok" || observed.observation.stripeAccountId !== binding.stripeAccountId || observed.observation.projectsProjectId !== binding.projectsProjectId || observed.observation.projectsEnvironment !== binding.projectsEnvironment) return result("blocked", "cannot verify the exact project/account/environment before linking");
  const coverage = approvalCovers(approval, plan, plan.operations[0]!.effects, deps.now());
  if (coverage.length) return result("blocked", coverage.join("; "));
  try { await deps.store.recordApproval(approval, deps.now()); } catch { return result("blocked", "provider grant approval rejected"); }
  const consumed = await deps.store.consumeApproval(approval.payload.approvalId, id, plan.digest, deps.now());
  if (consumed.status === "rejected") return result("blocked", consumed.reason);
  const existing = await deps.store.getOperation(id);
  if (existing && existing.planDigest !== plan.digest) return result("blocked", "operation belongs to another provider grant plan");
  if (existing?.state === "succeeded") return result("succeeded", null);
  if (!existing) await deps.store.createOperation({ id, environment: plan.environment, planDigest: plan.digest, approvalId: approval.payload.approvalId, state: "running" }, deps.now());
  // Associations are account-wide; different applications cannot issue a
  // conflicting link through the same control store while this is uncertain.
  const scope = `provider-link:${binding.stripeAccountId}:${provider}`;
  const reserved = await deps.store.reserve(scope, id, `link-${randomUUID()}`, 600_000, deps.now());
  if (reserved.status === "busy") return result("failed_retryable", "another provider grant holds this account");
  if (reserved.status === "uncertain" && reserved.reservation.operationId !== id) return result("outcome_unknown", "another account grant is uncertain; reconcile it first");
  const started = (await deps.store.events(id)).some((event) => event.kind === "infra.link.intent");
  const readAssociations = async () => {
    const status = await deps.adapter.read("status", [], deps.workspace);
    const parsed = status.status === "ok" && status.authenticated !== false ? providerStatus.safeParse(status.data) : null;
    if (!parsed?.success || parsed.data.project.id !== binding.projectsProjectId || parsed.data.project.merchant_id !== binding.stripeAccountId || parsed.data.active_environment !== binding.projectsEnvironment) return null;
    return parsed.data.providers.filter(row => row.name.toLowerCase() === provider);
  };
  if (!started) {
    if (reserved.status !== "acquired") return result("outcome_unknown", "grant reservation is uncertain");
    const before = await readAssociations();
    if (before === null || before.length > 1 || before.some(row => row.status !== "complete")) {
      await deps.store.release(scope, reserved.reservation.fencingToken);
      return result("blocked", "provider status is pending, ambiguous or from a different target; no grant was issued");
    }
    if (before.length === 1) {
      await deps.store.appendEvent(id, "infra.link.verified", { provider, connectionRequestId: before[0]!.account_request_id, providerAccountIdentity: "not_proven", mode: "observed_existing" }, deps.now());
      await deps.store.release(scope, reserved.reservation.fencingToken);
      await deps.store.setOperationState(id, "succeeded", deps.now());
      return result("succeeded", "existing association observed without a new grant; actual provider account identity remains unproven");
    }
    await deps.store.beginEffect(scope, reserved.reservation.fencingToken, `${id}:link`, deps.now());
    await deps.store.appendEvent(id, "infra.link.intent", { provider, allowAccountCreation: true, acceptTerms: plan.providerLink.acceptTerms }, deps.now());
    try { await deps.adapter.mutate("link", [provider], { yes: true, ...(plan.providerLink.acceptTerms ? { "accept-tos": true as const } : {}) }, deps.workspace, approval.payload.allowedEffects); } catch { /* No response is not proof of no grant. */ }
    await deps.store.markUncertain(scope, reserved.reservation.fencingToken, deps.now());
  }
  const found = await readAssociations();
  if (found === null || found.length !== 1 || found[0]!.status !== "complete") {
    await deps.store.setOperationState(id, "outcome_unknown", deps.now());
    return result("outcome_unknown", "provider authorization is pending or unrecognized; complete it with the account owner, then resume; no grant will be reissued");
  }
  const post = await deps.adapter.observe(deps.workspace, deps.now());
  if (post.status !== "ok" || post.observation.stripeAccountId !== binding.stripeAccountId || post.observation.projectsProjectId !== binding.projectsProjectId || post.observation.projectsEnvironment !== binding.projectsEnvironment) return result("needs_intervention", "project identity changed during authorization");
  await deps.store.appendEvent(id, "infra.link.verified", { provider, connectionRequestId: found[0]!.account_request_id, providerAccountIdentity: "not_proven" }, deps.now());
  await deps.store.reconcile(scope, `observed completed provider association ${found[0]!.account_request_id}`, id, deps.now());
  await deps.store.setOperationState(id, "succeeded", deps.now());
  // This proves the Projects association, not selection of a particular Neon
  // organization or Cloudflare account. Do not invent a providerAccountId.
  return result("succeeded", "association complete; verify the actual provider account before provisioning into an existing organization");
}
