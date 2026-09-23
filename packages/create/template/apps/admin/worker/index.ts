import { createAuth, loadAuthPolicy, type AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import {
  AccessDeniedError,
  AccessEvaluator,
  apiKeyStatus,
  applicationRoles,
  formatAccessExplanation,
  organizationRoles,
  permissions,
  platformRoles,
  publicDenial,
  type AccessSubject,
  type ApplicationEnvironment,
} from "@__TRESTLE_PROJECT_NAME__/authz";
import {
  compareEntitlements,
  draftNextVersion,
  Entitlements,
  evaluateQuota,
  explainEntitlements,
  usageProvenance,
  features,
  parsePlanVersionRef,
  periodBounds,
  planVersionRef,
  reconcileSubscription,
  resolveEffectiveEntitlements,
  reviseDraft,
  transitionPlanVersion,
  validateOverride,
  type PlanVersionState,
  type ProviderSubscriptionSnapshot,
  type SubscriptionOverride,
} from "@__TRESTLE_PROJECT_NAME__/billing";
import { createLogger } from "@__TRESTLE_PROJECT_NAME__/context";
import { loadAccessCatalog } from "@__TRESTLE_PROJECT_NAME__/data";
import { WebhookDomainError } from "@__TRESTLE_PROJECT_NAME__/domain";
import { PlatformAuthority, PlatformRequestError, PostgresPlatformRepository, type CapabilityStatus, type PlatformAudit } from "@__TRESTLE_PROJECT_NAME__/platform";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

import { registerAccessRoutes } from "./access.js";
import { registerCommunicationRoutes } from "./communications.js";
import { adminRoutePolicies } from "./route-policies.js";
import { registerSupportRoutes } from "./support.js";
import { registerAuthPolicyRoutes } from "./auth-policy.js";
import { registerBillingMappingRoutes, stripeRestCatalog, type StripeCatalog } from "./billing-mappings.js";
import { registerRegionalRoutes } from "./regional.js";
import { registerNotificationStreamRoutes } from "./streams.js";
import { registerWebhookManagementRoutes } from "./webhooks.js";

export interface AdminEnvironment extends AuthEnvironment {
  /** Distinct admin runtime login that is granted trestle_platform and never trestle_app. */
  PLATFORM_DATABASE_URL: string;
  ADMIN_ORIGIN?: string;
  ARTIFACT_RETENTION_DAYS?: string;
}

type Variables = { authority: PlatformAuthority; correlationId: string };
type Environment = { Bindings: AdminEnvironment; Variables: Variables };

/** Replaceable for tests. */
export const adminDependencies = {
  repository: (environment: AdminEnvironment) => new PostgresPlatformRepository(environment.PLATFORM_DATABASE_URL, environment.DATABASE_DRIVER),
  session: async (headers: Headers, environment: AdminEnvironment) => await adminAuth(environment).api.getSession({ headers }) as null | { user: { id: string; email: string; name: string }; session: { id: string; createdAt: Date | string } },
  assurance: async (environment: AdminEnvironment, sessionId: string) => await adminDependencies.repository(environment).assurance(sessionId),
  providerSnapshot: async (environment: AdminEnvironment, subscription: { organizationId: string; provider: string; providerSubscriptionId?: string }): Promise<ProviderSubscriptionSnapshot | null | "unconfigured"> => {
    if (subscription.provider === "local") return null;
    if (subscription.provider !== "stripe" || !environment.STRIPE_SECRET_KEY || !subscription.providerSubscriptionId) return "unconfigured";
    const response = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscription.providerSubscriptionId)}`, { headers: { authorization: `Bearer ${environment.STRIPE_SECRET_KEY}` } });
    if (response.status === 404) return null;
    if (!response.ok) throw new PlatformRequestError(409, "provider_unavailable", `Stripe returned ${response.status}`);
    const body = await response.json() as { id: string; status: string; cancel_at_period_end: boolean; current_period_end?: number; metadata?: { plan?: string } };
    const status = body.status === "canceled" ? "cancelled" : ["active", "trialing", "past_due", "incomplete"].includes(body.status) ? body.status as ProviderSubscriptionSnapshot["status"] : "incomplete";
    return { organizationId: subscription.organizationId, provider: "stripe", providerSubscriptionId: body.id, plan: body.metadata?.plan ?? "unknown", status, cancelAtPeriodEnd: body.cancel_at_period_end, ...(body.current_period_end ? { currentPeriodEnd: new Date(body.current_period_end * 1000) } : {}) };
  },
  /** Stripe catalog calls for product/price mapping; unconfigured without a key or in local Stripe mode. */
  stripe: (environment: AdminEnvironment): StripeCatalog | "unconfigured" => environment.STRIPE_SECRET_KEY && (environment.STRIPE_MODE ?? "local") !== "local" ? stripeRestCatalog(environment.STRIPE_SECRET_KEY) : "unconfigured",
  now: () => new Date(),
};

const environmentOf = (environment: AdminEnvironment): ApplicationEnvironment => environment.APP_ENV ?? "local";

/** Seeded by `trestle dev` (packages/auth/scripts/seed-local-admin.ts); never valid outside local. */
const localAdminEmail = "admin@trestle.local";

/**
 * Better Auth for operators runs on the admin origin with its own cookies and session posture.
 * Operators always have passkeys and two-factor (platform role changes and tenant entry require
 * phishing-resistant evidence) and never tenant SSO or directory provisioning.
 */
function adminAuth(environment: AdminEnvironment) {
  const origin = environment.ADMIN_ORIGIN ?? "http://localhost:42070";
  return createAuth({ ...environment, BETTER_AUTH_URL: origin, WEB_ORIGIN: origin }, { cookiePrefix: "trestle-admin", capabilities: { passkeys: true, twoFactor: true, sso: "disabled", directory: "disabled" } });
}

export const admin = new Hono<Environment>();

admin.use("/api/*", async (context, next) => cors({ origin: context.env.ADMIN_ORIGIN ?? "http://localhost:42070", credentials: true })(context, next));

admin.on(["GET", "POST"], "/api/auth/*", async (context) => { await loadAuthPolicy(context.env); return adminAuth(context.env).handler(context.req.raw); });

admin.get("/api/admin/health/live", (context) => context.json({ status: "ok" }));

admin.use("/api/admin/*", async (context, next) => {
  if (context.req.path === "/api/admin/health/live") return next();
  const supplied = context.req.header("x-correlation-id");
  const correlationId = supplied && /^[A-Za-z0-9._:-]{1,128}$/u.test(supplied) ? supplied : crypto.randomUUID();
  context.header("x-correlation-id", correlationId);
  context.header("cache-control", "no-store");
  const session = await adminDependencies.session(context.req.raw.headers, context.env);
  if (!session) return context.json({ error: "unauthorized", message: "Sign in as a platform operator" }, 401);
  // The seeded admin/admin operator exists only for local development.
  if (session.user.email === localAdminEmail && environmentOf(context.env) !== "local") return context.json({ error: "forbidden", reason: "local_account", message: "The default local admin account cannot be used outside local development" }, 403);
  const roles = await adminDependencies.repository(context.env).activePlatformRoles(session.user.id);
  const assurance = await adminDependencies.assurance(context.env, session.session.id);
  const { policy } = await loadAuthPolicy(context.env);
  const authority = new PlatformAuthority({ id: session.user.id, email: session.user.email, name: session.user.name }, roles, assurance, adminDependencies.now, environmentOf(context.env), policy.stepUp.windowMinutes);
  // Authentication alone grants nothing: operators need at least one platform-role assignment.
  if (authority.permissions.length === 0) return context.json({ error: "forbidden", reason: "no_platform_roles", message: "No platform role is assigned to this user" }, 403);
  context.set("authority", authority);
  context.set("correlationId", correlationId);
  await next();
});

admin.onError((error, context) => {
  if (error instanceof AccessDeniedError) return context.json(publicDenial(error.decision), 403);
  if (error instanceof WebhookDomainError) return context.json({ error: error.code, message: error.message }, error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 422);
  if (error instanceof PlatformRequestError) return context.json({ error: error.code, ...(error.decision ? { reason: error.decision.reason } : {}), ...(error.details ?? {}), message: error.message }, error.status);
  if (error instanceof z.ZodError) return context.json({ error: "invalid", message: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ") }, 422);
  createLogger({ correlationId: context.get("correlationId") ?? "unknown" }).error("platform.admin.failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
  return context.json({ error: "internal_error", message: "The request could not be completed" }, 500);
});

const reasonBody = z.object({ reason: z.string() }).passthrough();
async function json<T extends z.ZodType>(context: Context<Environment>, schema: T): Promise<z.infer<T>> {
  return schema.parse(await context.req.json().catch(() => ({})));
}

function audit(context: Context<Environment>, entry: Omit<PlatformAudit, "actorId" | "environment" | "correlationId" | "now">): PlatformAudit {
  return { ...entry, actorId: context.get("authority").operator.id, environment: environmentOf(context.env), correlationId: context.get("correlationId"), now: adminDependencies.now() };
}

async function capabilities(context: Context<Environment>): Promise<CapabilityStatus[]> {
  const reported = await adminDependencies.repository(context.env).capabilityStatuses(environmentOf(context.env));
  const admin: CapabilityStatus = { id: "admin", label: "Platform admin", state: environmentOf(context.env) === "local" ? "configured" : "deployed", healthy: true };
  if (reported.length === 0) {
    const repair = `pnpm exec trestle setup --env ${environmentOf(context.env)}`;
    return [admin, { id: "plans", label: "Customer Worker", state: "declared", healthy: false, message: "The customer Worker has not reported capability status yet. Load the application or call its /api/health endpoint.", repair }];
  }
  const stale = adminDependencies.now().getTime() - Math.max(...reported.map((status) => Date.parse(status.reportedAt))) > 24 * 3_600_000;
  return [admin, ...reported.filter((status) => status.id !== "admin").map(({ reportedAt: _reportedAt, ...status }) => stale ? { ...status, healthy: false, message: `${status.message ?? status.label} Status is older than 24 hours.` } : status)];
}

admin.get("/api/admin/session", async (context) => {
  const authority = context.get("authority");
  return context.json({
    operator: authority.operator, roles: authority.roles, permissions: authority.permissions, environment: environmentOf(context.env),
    stepUpRequiredAfter: authority.stepUpRequiredAfter.toISOString(), supportSession: await activeSupportSession(context),
    assurance: authority.assurance ? { level: authority.assurance.level, method: authority.assurance.method, verifiedAt: authority.assurance.verifiedAt.toISOString() } : null,
  });
});

/** The operator's support session, or null; an expired one is ended here. */
async function activeSupportSession(context: Context<Environment>) {
  const repository = adminDependencies.repository(context.env);
  const session = await repository.activeSupportSession(context.get("authority").operator.id);
  if (!session) return null;
  if (Date.parse(session.expiresAt) > adminDependencies.now().getTime()) return session;
  await repository.mutate(repository.endSupportSession(session.id, "expired", "system:support-expiry"), audit(context, { name: "platform.support_session.expired", organizationId: session.organizationId, targetType: "support_session", targetId: session.id, reason: "session reached its expiration", summary: {} }));
  return null;
}

admin.get("/api/admin/capabilities", async (context) => {
  context.get("authority").require("platform.overview.read");
  return context.json({ capabilities: await capabilities(context) });
});

admin.get("/api/admin/overview", async (context) => {
  context.get("authority").require("platform.overview.read");
  const repository = adminDependencies.repository(context.env);
  const [statuses, counts, applied, found] = await Promise.all([capabilities(context), repository.counts(), repository.migrationsApplied(), repository.overviewExceptions(adminDependencies.now())]);
  const state = (id: string) => statuses.find((status) => status.id === id);
  // Exceptions first (§3.2): incomplete or unhealthy setup, then operational failures, each linked to its resource.
  const setup = statuses.filter((status) => status.state !== "disabled" && (!status.healthy || status.state === "declared")).map((status) => ({
    kind: "capability", severity: status.healthy ? "warning" as const : "critical" as const, title: `${status.label} ${status.healthy ? "is not configured" : "is unhealthy"}`,
    detail: [status.message, status.repair ? `Repair: ${status.repair}` : null].filter(Boolean).join(" · ") || status.state, href: "/system/health",
  }));
  const exceptions = [...setup, ...found].sort((a, b) => Number(b.severity === "critical") - Number(a.severity === "critical"));
  return context.json({
    exceptions,
    environment: environmentOf(context.env), capabilities: statuses,
    providers: {
      email: { mode: state("email")?.state === "disabled" ? "disabled" : state("email")?.mode ?? "not yet reported", healthy: state("email")?.healthy ?? false, ...(state("email")?.message ? { detail: state("email")!.message } : {}) },
      payments: { mode: state("payments")?.state === "disabled" ? "disabled" : state("payments")?.mode ?? "not yet reported", healthy: state("payments")?.healthy ?? false, ...(state("payments")?.message ? { detail: state("payments")!.message } : {}) },
    },
    migrations: { applied: applied ?? 0 }, counts,
  });
});

admin.get("/api/admin/health", async (context) => {
  context.get("authority").require("platform.overview.read");
  const database = await adminDependencies.repository(context.env).ping();
  const statuses = await capabilities(context).catch(() => []);
  return context.json({ checks: [
    { name: "platform database role", status: database ? "ok" : "failed", detail: database ? "trestle_platform connection succeeded" : "cannot reach PostgreSQL as trestle_platform" },
    { name: "admin origin isolation", status: context.env.ADMIN_ORIGIN && context.env.ADMIN_ORIGIN !== context.env.WEB_ORIGIN ? "ok" : environmentOf(context.env) === "local" ? "ok" : "degraded", detail: "admin must be served from its own origin" },
    ...statuses.filter((status) => status.state !== "disabled").map((status) => ({ name: status.label, status: status.healthy ? "ok" : "degraded", ...(status.message ? { detail: status.message } : {}) })),
  ] });
});

admin.get("/api/admin/organizations", async (context) => {
  context.get("authority").require("platform.organizations.read");
  return context.json({ organizations: await adminDependencies.repository(context.env).searchOrganizations(context.req.query("q")) });
});

admin.get("/api/admin/organizations/:id", async (context) => {
  context.get("authority").require("platform.organizations.read");
  const found = await adminDependencies.repository(context.env).organization(context.req.param("id"));
  return found ? context.json(found) : context.json({ error: "not_found", message: "Organization not found" }, 404);
});

admin.get("/api/admin/users", async (context) => {
  context.get("authority").require("platform.users.read");
  return context.json({ users: await adminDependencies.repository(context.env).searchUsers(context.req.query("q")) });
});

for (const [action, permission, name] of [["suspend", "platform.users.suspend", "platform.user.suspended"], ["restore", "platform.users.suspend", "platform.user.restored"], ["sessions/revoke", "platform.sessions.revoke", "platform.sessions.revoked"]] as const) {
  admin.post(`/api/admin/users/:id/${action}`, async (context) => {
    const reason = context.get("authority").requireSensitive(permission, (await json(context, reasonBody)).reason);
    const id = context.req.param("id");
    const repository = adminDependencies.repository(context.env);
    if (!(await repository.userExists(id))) throw new PlatformRequestError(404, "not_found", "User not found");
    if (id === context.get("authority").operator.id && action === "suspend") throw new PlatformRequestError(409, "self_action", "Operators cannot suspend themselves");
    const statements = action === "suspend" ? repository.suspendUser(id, reason) : action === "restore" ? repository.restoreUser(id) : repository.revokeSessions(id);
    await repository.mutate(statements, audit(context, { name, organizationId: null, targetType: "user", targetId: id, reason, summary: {} }));
    return context.json({ succeeded: [id] });
  });
}

admin.get("/api/admin/features", (context) => {
  context.get("authority").require("platform.plans.read");
  return context.json({ features: features.list() });
});

admin.get("/api/admin/plans", async (context) => {
  context.get("authority").require("platform.plans.read");
  return context.json({ versions: await adminDependencies.repository(context.env).planVersions() });
});

/** New plan: a stable key (immutable once created) and version 1 as an empty draft. */
admin.post("/api/admin/plans", async (context) => {
  const input = await json(context, z.object({ name: z.string().trim().min(1).max(80), key: z.string().trim().regex(/^[a-z][a-z0-9_-]{1,39}$/u, "use 2-40 lowercase letters, digits, hyphens, or underscores"), reason: z.string() }).strict());
  const reason = context.get("authority").requireSensitive("platform.plans.manage", input.reason);
  const repository = adminDependencies.repository(context.env);
  if ((await repository.planVersions()).some((version) => version.plan === input.key)) throw new PlatformRequestError(409, "conflict", `A plan with the key ${input.key} already exists`);
  const draft = { plan: input.key, version: 1, name: input.name, state: "draft" as const, entitlements: {} };
  await repository.mutate(repository.insertPlanVersion(draft, context.get("authority").operator.id), audit(context, { name: "commercial.plan.created", organizationId: null, targetType: "plan_version", targetId: planVersionRef(draft), reason, summary: { name: input.name } }));
  return context.json(draft, 201);
});

admin.post("/api/admin/plans/:plan/versions", async (context) => {
  const reason = context.get("authority").requireSensitive("platform.plans.manage", (await json(context, reasonBody)).reason);
  const repository = adminDependencies.repository(context.env);
  let draft;
  try { draft = draftNextVersion(await repository.planVersions(), context.req.param("plan")); } catch (error) { throw new PlatformRequestError(409, "conflict", error instanceof Error ? error.message : String(error)); }
  await repository.mutate(repository.insertPlanVersion(draft, context.get("authority").operator.id), audit(context, { name: "commercial.plan_version.drafted", organizationId: null, targetType: "plan_version", targetId: planVersionRef(draft), reason, summary: {} }));
  return context.json(draft, 201);
});

admin.patch("/api/admin/plans/:plan/versions/:version", async (context) => {
  context.get("authority").require("platform.plans.manage");
  const input = await json(context, z.object({ name: z.string().min(1).max(80).optional(), entitlements: z.record(z.string(), z.record(z.string(), z.union([z.boolean(), z.number(), z.string(), z.null()]))).optional() }).strict());
  const repository = adminDependencies.repository(context.env);
  const current = await repository.planVersion(context.req.param("plan"), Number(context.req.param("version")));
  if (!current) throw new PlatformRequestError(404, "not_found", "Plan version not found");
  let revised;
  try { revised = reviseDraft(current, { ...(input.name ? { name: input.name } : {}), ...(input.entitlements ? { entitlements: input.entitlements } : {}) }); } catch (error) { throw new PlatformRequestError(422, "invalid", error instanceof Error ? error.message : String(error)); }
  await repository.mutate(repository.updateDraft(revised), audit(context, { name: "commercial.plan_version.revised", organizationId: null, targetType: "plan_version", targetId: planVersionRef(revised), reason: "draft edit", summary: { features: Object.keys(revised.entitlements).sort() } }));
  return context.json(revised);
});

admin.post("/api/admin/plans/:plan/versions/:version/transition", async (context) => {
  const input = await json(context, z.object({ to: z.enum(["active", "grandfathered", "retired"]), reason: z.string() }));
  const reason = context.get("authority").requireSensitive("platform.plans.manage", input.reason);
  const repository = adminDependencies.repository(context.env);
  const current = await repository.planVersion(context.req.param("plan"), Number(context.req.param("version")));
  if (!current) throw new PlatformRequestError(404, "not_found", "Plan version not found");
  if (input.to === "retired" && await repository.subscriptionsOnVersion(planVersionRef(current)) > 0) throw new PlatformRequestError(409, "in_use", `${planVersionRef(current)} still has subscriptions; migrate them first`);
  const statements = [];
  if (input.to === "active") {
    const previous = (await repository.planVersions()).find((version) => version.plan === current.plan && version.state === "active");
    if (previous) statements.push(...repository.transitionPlanVersion(transitionPlanVersion(previous, "grandfathered", adminDependencies.now()), "active"));
  }
  let next;
  try { next = transitionPlanVersion(current, input.to as PlanVersionState, adminDependencies.now()); } catch (error) { throw new PlatformRequestError(409, "invalid_transition", error instanceof Error ? error.message : String(error)); }
  statements.push(...repository.transitionPlanVersion(next, current.state));
  await repository.mutate(statements, audit(context, { name: `commercial.plan_version.${input.to === "active" ? "activated" : input.to}`, organizationId: null, targetType: "plan_version", targetId: planVersionRef(next), reason, summary: { from: current.state, to: input.to } }));
  return context.json(next);
});

admin.get("/api/admin/subscriptions", async (context) => {
  context.get("authority").require("platform.subscriptions.read");
  return context.json({ subscriptions: await adminDependencies.repository(context.env).subscriptions(context.req.query("q")) });
});

admin.get("/api/admin/subscriptions/:organizationId", async (context) => {
  context.get("authority").require("platform.subscriptions.read");
  const organizationId = context.req.param("organizationId");
  const repository = adminDependencies.repository(context.env);
  const [state, scheduledChanges, reconciliations, effective, subscriptions, lines, providerIds] = await Promise.all([repository.subscriptionState(organizationId), repository.scheduledChanges(organizationId), repository.reconciliations(organizationId), repository.effectiveEntitlements(organizationId), repository.subscriptions(organizationId), repository.subscriptionLines(organizationId), repository.subscriptionProviderIds(organizationId)]);
  const subscription = subscriptions.find((row) => row.organizationId === organizationId) ?? null;
  // The resolved provider chain (§4.2): each link is an explicit mapping or a recorded provider ID, never a name match.
  const environment = environmentOf(context.env);
  const mappings = subscription ? await repository.billingMappings({ environment, provider: "stripe", plan: subscription.plan }) : [];
  const version = subscription?.planVersion ? Number(subscription.planVersion.split("@")[1]) : null;
  const chain = subscription ? {
    environment, provider: subscription.provider,
    product: mappings.find((mapping) => mapping.kind === "product") ?? null,
    prices: mappings.filter((mapping) => mapping.kind === "price" && mapping.planVersion === version),
    customerId: providerIds?.customerId ?? null, subscriptionId: providerIds?.subscriptionId ?? null,
    lines: lines.map((line) => ({ ...line, mapping: mappings.find((mapping) => mapping.kind === "price" && mapping.externalId === line.providerPriceId) ?? null })),
    reconciliation: reconciliations[0] ?? null,
  } : null;
  return context.json({ subscription, planVersion: state.planVersion, overrides: state.overrides, scheduledChanges, reconciliations, effective, chain });
});

admin.post("/api/admin/subscriptions/:organizationId/overrides", async (context) => {
  const input = await json(context, z.object({ code: z.string(), enabled: z.boolean(), values: z.record(z.string(), z.union([z.boolean(), z.number(), z.string(), z.null()])), effectiveAt: z.iso.datetime(), expiresAt: z.iso.datetime().optional(), reason: z.string() }));
  const authority = context.get("authority");
  const reason = authority.requireSensitive("platform.subscriptions.manage", input.reason);
  const organizationId = context.req.param("organizationId");
  const override: SubscriptionOverride = { id: crypto.randomUUID(), organizationId, code: input.code, enabled: input.enabled, values: input.values, reason, author: authority.operator.id, effectiveAt: new Date(input.effectiveAt), expiresAt: input.expiresAt ? new Date(input.expiresAt) : null };
  const problems = validateOverride(features, override);
  if (problems.length) throw new PlatformRequestError(422, "invalid", problems.join("; "));
  const repository = adminDependencies.repository(context.env);
  const state = await repository.subscriptionState(organizationId);
  if (!state.row) throw new PlatformRequestError(404, "not_found", "Subscription not found");
  const recompute = await repository.recomputeStatements(organizationId, adminDependencies.now(), [...state.overrides, override]);
  await repository.mutate([...repository.insertOverride(override), ...recompute], audit(context, { name: "commercial.override.created", organizationId, targetType: "subscription_override", targetId: override.id, reason, summary: { code: override.code, enabled: override.enabled, values: override.values, expiresAt: input.expiresAt ?? null } }));
  return context.json(override, 201);
});

admin.delete("/api/admin/subscriptions/:organizationId/overrides/:id", async (context) => {
  const authority = context.get("authority");
  const reason = authority.requireSensitive("platform.subscriptions.manage", (await json(context, reasonBody)).reason);
  const organizationId = context.req.param("organizationId");
  const id = context.req.param("id");
  const repository = adminDependencies.repository(context.env);
  const state = await repository.subscriptionState(organizationId);
  if (!state.overrides.some((override) => override.id === id && !override.removedAt)) throw new PlatformRequestError(404, "not_found", "Active override not found");
  const recompute = await repository.recomputeStatements(organizationId, adminDependencies.now(), state.overrides.map((override) => override.id === id ? { ...override, removedAt: adminDependencies.now() } : override));
  await repository.mutate([...repository.removeOverride(organizationId, id, authority.operator.id, reason), ...recompute], audit(context, { name: "commercial.override.removed", organizationId, targetType: "subscription_override", targetId: id, reason, summary: {} }));
  return context.json({ succeeded: [id] });
});

admin.post("/api/admin/subscriptions/:organizationId/changes", async (context) => {
  const input = await json(context, z.object({ toPlanVersion: z.string(), effectiveAt: z.iso.datetime(), reason: z.string() }));
  const authority = context.get("authority");
  const reason = authority.requireSensitive("platform.subscriptions.manage", input.reason);
  const ref = parsePlanVersionRef(input.toPlanVersion);
  const repository = adminDependencies.repository(context.env);
  const target = ref ? await repository.planVersion(ref.plan, ref.version) : null;
  if (!target || !["active", "grandfathered"].includes(target.state)) throw new PlatformRequestError(422, "invalid", "Scheduled changes must target an active or grandfathered plan version");
  const organizationId = context.req.param("organizationId");
  const id = crypto.randomUUID();
  await repository.mutate(repository.scheduleChange(organizationId, id, input.toPlanVersion, new Date(input.effectiveAt), reason, authority.operator.id), audit(context, { name: "commercial.subscription_change.scheduled", organizationId, targetType: "subscription_change", targetId: id, reason, summary: { toPlanVersion: input.toPlanVersion, effectiveAt: input.effectiveAt } }));
  return context.json({ id, toPlanVersion: input.toPlanVersion, effectiveAt: input.effectiveAt, reason, author: authority.operator.id, status: "scheduled" }, 201);
});

admin.post("/api/admin/subscriptions/:organizationId/reconcile", async (context) => {
  const authority = context.get("authority");
  const reason = authority.requireSensitive("platform.reconciliation.run", (await json(context, reasonBody)).reason);
  const organizationId = context.req.param("organizationId");
  const repository = adminDependencies.repository(context.env);
  const current = (await repository.subscriptions(organizationId)).find((row) => row.organizationId === organizationId);
  if (!current) throw new PlatformRequestError(404, "not_found", "Subscription not found");
  const local = { organizationId, provider: current.provider, ...(current.providerSubscriptionId ? { providerSubscriptionId: current.providerSubscriptionId } : {}), plan: current.plan, status: current.status as ProviderSubscriptionSnapshot["status"], cancelAtPeriodEnd: current.cancelAtPeriodEnd, ...(current.currentPeriodEnd ? { currentPeriodEnd: new Date(current.currentPeriodEnd) } : {}), entitlements: [] };
  const snapshot = await adminDependencies.providerSnapshot(context.env, local);
  if (snapshot === "unconfigured") throw new PlatformRequestError(409, "provider_unconfigured", `Reconciliation with ${current.provider} is not configured for this admin environment. Run: pnpm exec trestle setup --env ${environmentOf(context.env)}`);
  const result = current.provider === "local" ? { organizationId, outcome: "in_sync" as const, differences: [] } : reconcileSubscription(organizationId, local, snapshot);
  await repository.mutate(repository.recordReconciliation(organizationId, current.provider, result.outcome, result.differences, authority.operator.id, reason), audit(context, { name: "commercial.reconciliation.recorded", organizationId, targetType: "subscription", targetId: organizationId, reason, summary: { outcome: result.outcome, fields: result.differences.map((difference) => difference.field) } }));
  return context.json({ ...result, ranAt: adminDependencies.now().toISOString(), actor: authority.operator.id });
});

admin.get("/api/admin/entitlements/:organizationId", async (context) => {
  context.get("authority").require("platform.subscriptions.read");
  const organizationId = context.req.param("organizationId");
  const repository = adminDependencies.repository(context.env);
  const [effective, usage, usageRows] = await Promise.all([repository.effectiveEntitlements(organizationId), repository.usage(organizationId), repository.usageRows(organizationId)]);
  const now = adminDependencies.now();
  const quotas = effective.filter((entry) => entry.enabled && features.get(entry.code)?.metered).map((entry) => {
    const period = periodBounds(features.get(entry.code)!.metered!.period, now);
    return evaluateQuota(entry, usage.find((row) => row.code === entry.code && row.start.getTime() === period.start.getTime())?.quantity ?? 0, period, 0);
  });
  // Where each figure came from: the local projection authorization reads, and the provider's own report.
  const metering = usageRows.map((row) => usageProvenance(row)).map((entry) => ({ ...entry, periodStart: entry.periodStart.toISOString(), periodEnd: entry.periodEnd.toISOString(), providerObservedAt: entry.providerObservedAt?.toISOString() ?? null }));
  // The explorer (§4.3): the whole catalog, so unavailable features are visible, with per-value provenance.
  const [state, scheduledChanges, subscriptions] = await Promise.all([repository.subscriptionState(organizationId), repository.scheduledChanges(organizationId), repository.subscriptions(organizationId)]);
  const subscription = subscriptions.find((row) => row.organizationId === organizationId) ?? null;
  const live = state.overrides.filter((override) => !override.removedAt && (!override.expiresAt || override.expiresAt > now));
  return context.json({
    effective, quotas, metering,
    subscription: subscription ? { ...subscription, planName: state.planVersion?.name ?? null } : null,
    features: explainEntitlements(features, effective, state.overrides),
    overrides: live.map((override) => ({ id: override.id, code: override.code, enabled: override.enabled, values: override.values, reason: override.reason, author: override.author, effectiveAt: override.effectiveAt.toISOString(), expiresAt: override.expiresAt?.toISOString() ?? null, scheduled: override.effectiveAt > now })),
    scheduledChanges: scheduledChanges.filter((change) => change.status === "scheduled"),
  });
});

/** Compare changes (§4.3): the organization's effective entitlements now versus a proposed plan version and overrides. Nothing is written. */
admin.post("/api/admin/entitlements/:organizationId/compare", async (context) => {
  const authority = context.get("authority");
  authority.require("platform.subscriptions.read");
  const organizationId = context.req.param("organizationId");
  const input = await json(context, z.object({
    planVersion: z.string().optional(), removeOverrides: z.array(z.string()).max(50).default([]),
    overrides: z.array(z.object({ code: z.string(), enabled: z.boolean(), values: z.record(z.string(), z.union([z.boolean(), z.number(), z.string(), z.null()])), expiresAt: z.string().datetime().optional() })).max(50).default([]),
  }).strict());
  const repository = adminDependencies.repository(context.env);
  const state = await repository.subscriptionState(organizationId);
  const now = adminDependencies.now();
  const ref = input.planVersion ? parsePlanVersionRef(input.planVersion) : null;
  const target = ref ? await repository.planVersion(ref.plan, ref.version) : state.planVersion;
  if (input.planVersion && !target) throw new PlatformRequestError(404, "not_found", "Plan version not found");
  const proposed = input.overrides.map((override, index): SubscriptionOverride => ({ code: override.code, enabled: override.enabled, values: override.values, id: `proposed-${index}`, organizationId, reason: "comparison", author: authority.operator.id, effectiveAt: new Date(now.getTime() - 1), ...(override.expiresAt ? { expiresAt: new Date(override.expiresAt) } : {}) }));
  const problems = proposed.flatMap((override) => validateOverride(features, override));
  if (problems.length) throw new PlatformRequestError(422, "invalid", problems.join("; "));
  const status = (state.row ? String(state.row.status) : "active") as never;
  const startedAt = state.row?.started_at ? new Date(String(state.row.started_at)) : undefined;
  const before = resolveEffectiveEntitlements(features, { status, planVersion: state.planVersion, ...(startedAt ? { startedAt } : {}) }, state.overrides, now);
  const kept = state.overrides.filter((override) => !input.removeOverrides.includes(override.id));
  const after = resolveEffectiveEntitlements(features, { status, planVersion: target, ...(startedAt ? { startedAt } : {}) }, [...kept, ...proposed], now);
  return context.json({ from: state.planVersion ? `${state.planVersion.plan}@${state.planVersion.version}` : null, to: target ? `${target.plan}@${target.version}` : null, changes: compareEntitlements(features, before, after) });
});

admin.post("/api/admin/entitlements/simulate", async (context) => {
  const authority = context.get("authority");
  authority.require("platform.plans.read");
  const input = await json(context, z.object({ planVersion: z.string(), overrides: z.array(z.object({ code: z.string(), enabled: z.boolean(), values: z.record(z.string(), z.union([z.boolean(), z.number(), z.string(), z.null()])) })).max(50) }));
  const ref = parsePlanVersionRef(input.planVersion);
  const version = ref ? await adminDependencies.repository(context.env).planVersion(ref.plan, ref.version) : null;
  if (!version) throw new PlatformRequestError(404, "not_found", "Plan version not found");
  const now = adminDependencies.now();
  const overrides = input.overrides.map((override, index): SubscriptionOverride => ({ ...override, id: `simulated-${index}`, organizationId: "simulation", reason: "simulation", author: authority.operator.id, effectiveAt: new Date(now.getTime() - 1) }));
  const problems = overrides.flatMap((override) => validateOverride(features, override));
  if (problems.length) throw new PlatformRequestError(422, "invalid", problems.join("; "));
  return context.json({ effective: resolveEffectiveEntitlements(features, { status: "active", planVersion: version }, overrides, now) });
});

admin.get("/api/admin/permissions", (context) => {
  context.get("authority").require("platform.roles.read");
  return context.json({ permissions: permissions.list().map((permission) => ({ ...permission, enforcedBy: adminRoutePolicies.customer.filter((route) => route.permission === permission.code).map((route) => `customer ${route.method} ${route.path}`).concat(adminRoutePolicies.admin.filter((route) => route.permission === permission.code).map((route) => `admin ${route.method} ${route.path}`)).concat(adminRoutePolicies.support.filter((route) => route.permission === permission.code).map((route) => `support ${route.method} ${route.path}`)) })) });
});

admin.get("/api/admin/roles", (context) => {
  context.get("authority").require("platform.roles.read");
  const shape = (catalog: typeof organizationRoles) => catalog.list().map(({ key, name, description, plane, permissions: granted, custom }) => ({ key, name, description, plane, permissions: granted, custom }));
  return context.json({ organization: shape(organizationRoles), application: shape(applicationRoles), platform: shape(platformRoles) });
});

admin.get("/api/admin/route-policies", (context) => {
  context.get("authority").require("platform.roles.read");
  return context.json({ routes: adminRoutePolicies.customer });
});

admin.get("/api/admin/application-role-assignments", async (context) => {
  context.get("authority").require("platform.roles.read");
  return context.json({ assignments: await adminDependencies.repository(context.env).applicationRoleAssignments(context.req.query("organizationId") || undefined) });
});

admin.get("/api/admin/platform-roles", async (context) => {
  context.get("authority").require("platform.roles.read");
  return context.json({ assignments: await adminDependencies.repository(context.env).platformRoleAssignments(context.req.query("history") === "1") });
});

admin.post("/api/admin/platform-roles", async (context) => {
  const input = await json(context, z.object({ userId: z.string().min(1), role: z.string(), reason: z.string() }));
  const authority = context.get("authority");
  const reason = authority.requireSensitive("platform.roles.manage", input.reason);
  if (!platformRoles.get(input.role)) throw new PlatformRequestError(422, "invalid", `${input.role} is not a platform role`);
  const repository = adminDependencies.repository(context.env);
  if (!(await repository.userExists(input.userId))) throw new PlatformRequestError(404, "not_found", "User not found");
  await repository.mutate(repository.assignPlatformRole(input.userId, input.role, authority.operator.id, reason), audit(context, { name: "platform.role.assigned", organizationId: null, targetType: "user", targetId: input.userId, reason, summary: { role: input.role } }));
  return context.json({ succeeded: [input.userId] }, 201);
});

admin.delete("/api/admin/platform-roles/:userId/:role", async (context) => {
  const authority = context.get("authority");
  const reason = authority.requireSensitive("platform.roles.manage", (await json(context, reasonBody)).reason);
  const userId = context.req.param("userId");
  const role = context.req.param("role");
  if (userId === authority.operator.id) throw new PlatformRequestError(409, "self_action", "Operators cannot revoke their own platform roles");
  const repository = adminDependencies.repository(context.env);
  await repository.mutate(repository.revokePlatformRole(userId, role, authority.operator.id, reason), audit(context, { name: "platform.role.revoked", organizationId: null, targetType: "user", targetId: userId, reason, summary: { role } }));
  return context.json({ succeeded: [userId] });
});

admin.post("/api/admin/access/explain", async (context) => {
  context.get("authority").require("platform.access.explain");
  const input = await json(context, z.object({ organizationId: z.string().min(1), principal: z.object({ type: z.enum(["user", "service_account"]), id: z.string().min(1) }), permission: z.string().optional(), entitlement: z.string().optional(), apiKeyId: z.string().optional() }).refine((value) => value.permission || value.entitlement, "permission or entitlement is required"));
  const repository = adminDependencies.repository(context.env);
  const [organization, effective, custom, access] = await Promise.all([repository.organization(input.organizationId), repository.effectiveEntitlements(input.organizationId), repository.customApplicationRoles(input.organizationId), loadAccessCatalog(repository.runner)]);
  if (!organization) throw new PlatformRequestError(404, "not_found", "Organization not found");
  const entitlements = new Entitlements(effective);
  // The same catalog the customer Worker resolves with: built-in, global catalog, then the tenant's own roles.
  const catalog = access.application.withCustomRoles(custom);
  let subject: AccessSubject;
  if (input.principal.type === "user") {
    const membership = await repository.membership(input.organizationId, input.principal.id);
    const platform = await repository.activePlatformRoles(input.principal.id);
    subject = {
      principal: { type: "user", id: input.principal.id, label: membership?.name ?? input.principal.id },
      tenant: { organizationId: input.organizationId, label: organization.organization.name },
      authority: membership ? { organization: access.organization.resolve(membership.organizationRoles).permissions, application: catalog.resolve(membership.applicationRoles).permissions, platform: platformRoles.resolve(platform).permissions } : { platform: platformRoles.resolve(platform).permissions },
      assignments: { organization: membership?.organizationRoles ?? [], application: membership?.applicationRoles ?? [], platform },
      entitlements,
      constraints: [{ name: "Organization membership", expected: "active member", actual: membership ? "active member" : "not a member", satisfied: Boolean(membership) }],
    };
  } else {
    const account = await repository.serviceAccount(input.organizationId, input.principal.id);
    if (!account) throw new PlatformRequestError(404, "not_found", "Service account not found in this organization");
    const key = input.apiKeyId ? await repository.apiKey(input.apiKeyId) : null;
    if (input.apiKeyId && (!key || key.organizationId !== input.organizationId || key.serviceAccountId !== account.id)) throw new PlatformRequestError(404, "not_found", "API key not found for this service account");
    const status = key ? apiKeyStatus({ ...key, id: key.id }, { now: adminDependencies.now(), environment: environmentOf(context.env), serviceAccountStatus: account.status === "active" ? "active" : "suspended" }) : undefined;
    subject = {
      principal: { type: "service_account", id: account.id, label: account.name },
      tenant: { organizationId: input.organizationId, label: organization.organization.name },
      authority: { application: catalog.resolve(account.applicationRoles).permissions },
      assignments: { application: account.applicationRoles },
      scopes: new Set(key?.scopes ?? []),
      ...(key && status ? { credential: { id: key.displayPrefix, status } } : {}),
      entitlements,
      constraints: key ? [{ name: "Environment", expected: key.environment, actual: environmentOf(context.env), satisfied: key.environment === environmentOf(context.env) }] : [],
    };
  }
  const decision = new AccessEvaluator(access.permissions, subject).explain({ ...(input.permission ? { permission: input.permission } : {}), ...(input.entitlement ? { entitlement: input.entitlement } : {}) });
  const explanation = [formatAccessExplanation(decision), "", `Resource tenant          ${organization.organization.name}`, `RLS tenant context       ${organization.organization.name} (forced RLS on every tenant query)`].join("\n");
  return context.json({ decision, explanation });
});

admin.get("/api/admin/service-accounts", async (context) => {
  context.get("authority").require("platform.machine_access.read");
  return context.json({ serviceAccounts: await adminDependencies.repository(context.env).serviceAccounts(context.req.query("organizationId") || undefined) });
});

admin.post("/api/admin/service-accounts/:id/suspend", async (context) => {
  const authority = context.get("authority");
  const reason = authority.requireSensitive("platform.machine_access.revoke", (await json(context, reasonBody)).reason);
  const repository = adminDependencies.repository(context.env);
  const account = (await repository.serviceAccounts()).find((candidate) => candidate.id === context.req.param("id"));
  if (!account) throw new PlatformRequestError(404, "not_found", "Service account not found");
  await repository.mutate(repository.suspendServiceAccount(account.id, authority.operator.id, reason), audit(context, { name: "access.service_account.suspended", organizationId: account.organizationId, targetType: "service_account", targetId: account.id, reason, summary: { by: "platform" } }));
  return context.json({ succeeded: [account.id] });
});

admin.get("/api/admin/api-keys", async (context) => {
  context.get("authority").require("platform.machine_access.read");
  return context.json({ apiKeys: await adminDependencies.repository(context.env).apiKeys(context.req.query("organizationId") || undefined) });
});

admin.post("/api/admin/api-keys/:id/revoke", async (context) => {
  const authority = context.get("authority");
  const reason = authority.requireSensitive("platform.machine_access.revoke", (await json(context, reasonBody)).reason);
  const repository = adminDependencies.repository(context.env);
  const key = await repository.apiKey(context.req.param("id"));
  if (!key) throw new PlatformRequestError(404, "not_found", "API key not found");
  await repository.mutate(repository.revokeApiKey(key.id, authority.operator.id, reason), audit(context, { name: "access.api_key.revoked", organizationId: key.organizationId, targetType: "api_key", targetId: key.id, reason, summary: { displayPrefix: key.displayPrefix, by: "platform" } }));
  return context.json({ succeeded: [key.id] });
});

admin.get("/api/admin/identity", async (context) => {
  context.get("authority").require("platform.identity.read");
  return context.json(await adminDependencies.repository(context.env).identityStatus());
});

admin.get("/api/admin/email", async (context) => {
  context.get("authority").require("platform.email.read");
  return context.json({ deliveries: await adminDependencies.repository(context.env).emailDeliveries(context.req.query("status") || undefined) });
});

admin.get("/api/admin/email/:id", async (context) => {
  context.get("authority").require("platform.email.read");
  const detail = await adminDependencies.repository(context.env).emailDeliveryDetail(context.req.param("id"));
  if (!detail) throw new PlatformRequestError(404, "not_found", "Email delivery not found");
  return context.json(detail);
});

admin.get("/api/admin/async", async (context) => {
  context.get("authority").require("platform.jobs.read");
  return context.json(await adminDependencies.repository(context.env).outbox());
});

admin.post("/api/admin/async/dead/:id/redrive", async (context) => {
  const reason = context.get("authority").requireSensitive("platform.jobs.redrive", (await json(context, reasonBody)).reason);
  const id = context.req.param("id");
  const repository = adminDependencies.repository(context.env);
  if (!(await repository.isDead(id))) throw new PlatformRequestError(409, "not_dead_lettered", "Only dead-lettered messages can be redriven");
  await repository.mutate(repository.redrive(id), audit(context, { name: "platform.async.redriven", organizationId: null, targetType: "outbox_message", targetId: id, reason, summary: {} }));
  return context.json({ succeeded: [id] });
});

admin.get("/api/admin/artifacts", async (context) => {
  context.get("authority").require("platform.artifacts.read");
  return context.json({ artifacts: await adminDependencies.repository(context.env).artifacts(context.req.query("organizationId") || undefined, Number(context.env.ARTIFACT_RETENTION_DAYS ?? 30)) });
});

admin.get("/api/admin/audit", async (context) => {
  context.get("authority").require("platform.audit.read");
  const organizationId = context.req.query("organizationId");
  const actor = context.req.query("actor");
  const name = context.req.query("name");
  const correlationId = context.req.query("correlation");
  const pageSize = Math.min(100, Math.max(10, Number(context.req.query("pageSize") ?? 50) || 50));
  const page = Math.max(1, Number(context.req.query("page") ?? 1) || 1);
  const result = await adminDependencies.repository(context.env).audit({ ...(organizationId ? { organizationId } : {}), ...(actor ? { actor } : {}), ...(name ? { name } : {}), ...(correlationId ? { correlationId } : {}) }, { limit: pageSize, offset: (page - 1) * pageSize });
  return context.json({ ...result, page, pageSize });
});

admin.get("/api/admin/audit/:id", async (context) => {
  context.get("authority").require("platform.audit.read");
  const { events: [event] } = await adminDependencies.repository(context.env).audit({ id: context.req.param("id") }, { limit: 1, offset: 0 });
  if (!event) throw new PlatformRequestError(404, "not_found", "Audit event not found");
  return context.json({ event });
});

const auditEntry = (context: Context<Environment>, entry: Omit<PlatformAudit, "actorId" | "environment" | "correlationId" | "now">) => audit(context, entry);
registerSupportRoutes(admin as never, { repository: (environment) => adminDependencies.repository(environment as AdminEnvironment), now: () => adminDependencies.now(), audit: auditEntry as never });
registerCommunicationRoutes(admin as never, { repository: (environment) => adminDependencies.repository(environment as AdminEnvironment), audit: auditEntry as never });
registerWebhookManagementRoutes(admin as never, { repository: (environment) => adminDependencies.repository(environment as AdminEnvironment), now: () => adminDependencies.now() });
registerAuthPolicyRoutes(admin as never, { repository: (environment) => adminDependencies.repository(environment as AdminEnvironment), audit: auditEntry as never, capabilities: (context) => capabilities(context as never) });
registerBillingMappingRoutes(admin as never, { repository: (environment) => adminDependencies.repository(environment as AdminEnvironment), audit: auditEntry as never, stripe: (environment) => adminDependencies.stripe(environment as AdminEnvironment) });
registerRegionalRoutes(admin as never, { repository: (environment) => adminDependencies.repository(environment as AdminEnvironment), now: () => adminDependencies.now() });
registerNotificationStreamRoutes(admin as never, { repository: (environment) => adminDependencies.repository(environment as AdminEnvironment), audit: auditEntry as never, now: () => adminDependencies.now() });
registerAccessRoutes(admin as never, {
  repository: (environment) => adminDependencies.repository(environment as AdminEnvironment), audit: auditEntry as never, now: () => adminDependencies.now(),
  enforcement: () => [...adminRoutePolicies.customer.map((route) => ({ surface: "customer", ...route })), ...adminRoutePolicies.admin.map((route) => ({ surface: "admin", ...route })), ...adminRoutePolicies.support.map((route) => ({ surface: "support", ...route }))],
});

/**
 * Applies scheduled subscription changes whose effective time has passed. It
 * runs as a declared system principal with the platform database role only.
 */
export async function applyDueSubscriptionChanges(environment: AdminEnvironment, now = adminDependencies.now()): Promise<number> {
  const repository = adminDependencies.repository(environment);
  let applied = 0;
  for (const change of await repository.dueChanges(now)) {
    await repository.mutate(await repository.applyChangeStatements(change, now), {
      name: "commercial.subscription_change.applied", actorId: "system:subscription-scheduler", organizationId: change.organizationId, targetType: "subscription_change", targetId: change.id,
      reason: "scheduled change reached its effective time", summary: { toPlanVersion: change.toPlanVersion }, environment: environmentOf(environment), correlationId: `scheduled:${change.id}`, now,
    }, "system");
    applied += 1;
  }
  return applied;
}

export default {
  fetch: admin.fetch.bind(admin),
  scheduled: async (_controller: unknown, environment: AdminEnvironment, context: { waitUntil(promise: Promise<unknown>): void }) => {
    context.waitUntil(applyDueSubscriptionChanges(environment));
  },
};
