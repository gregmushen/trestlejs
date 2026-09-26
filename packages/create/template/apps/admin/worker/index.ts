import { createAuth, type AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import {
  AccessDeniedError, actionAssuranceLevel, applicationRoles, assuranceRank, evaluateAccess, formatAccessExplanation, meetsRequirement, meetsSignInLevel, organizationRoles, permissions, platformAccess, platformAssuranceRequirement, platformRoles, publicDenial,
  stepUpWindowMinutes, type AccessEvaluator, type AssuranceLevel, type AssuranceRequirement,
} from "@__TRESTLE_PROJECT_NAME__/authz";
import { Entitlements, featureDefinitions } from "@__TRESTLE_PROJECT_NAME__/billing";
import { createLogger, loggerSecretsFromEnvironment } from "@__TRESTLE_PROJECT_NAME__/context";
import {
  artifactOperations, createDatabase, createPlatformDatabase, disableWebhookEndpoint, grantEntitlementOverride, listDeadOutboxEvents, listFailedWebhookDeliveries, listPlatformSubscriptions,
  activeSupportSession, endSupportSession, listSupportSessions, mintSupportHandoff, startSupportSession, supportableOrganizations, supportOrganizationView,
  grantPlatformRole, listPlatformAuditEvents, listPlatformEmailEvents, listPlatformRoleHolders, listPlatformServiceAccounts, platformAccessAssignments, listPlatformRoleAssignments, listPlatformUsers, organizationRegionalOverrides, platformAuditEvent, platformOrganizationDetail, PlatformRoleError, revokePlatformRole,
  listPlatformApiKeys, listPlatformOrganizations, listPlatformWebhookEndpoints, outboxStatusCounts, MachineAccessError, platformCommercialDetail, platformRevokeApiKey, PlatformOperationError, redriveOutboxEvent, replayWebhookDelivery, revokeEntitlementOverride,
  sessionAssurance, type Database, type DatabaseDriver, type PlatformChangeContext, type SessionAssurance,
} from "@__TRESTLE_PROJECT_NAME__/db";
import { buildOpenApi } from "@__TRESTLE_PROJECT_NAME__/contracts";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";

import { adminViews, stepUpExemptRoutes, type AdminCapability } from "../src/api-registry.js";
import { databaseReachable, enrolledFactors, overview, platformRolesFor, strongestEnrolledFactor } from "./data.js";
import { adminFactorPlugins } from "./factors.js";
import { adminPolicyFor, adminRoutePolicies } from "./route-policies.js";

export type AdminEnvironment = {
  DATABASE_URL: string;
  DATABASE_DRIVER?: DatabaseDriver;
  /** Distinct login granted only trestle_platform. Required outside local development. */
  DATABASE_ADMIN_URL?: string;
  BETTER_AUTH_SECRET: string;
  /** This admin Worker's public URL (a deploy-time variable; the customer Worker's BETTER_AUTH_URL is not used). */
  ADMIN_API_URL?: string;
  /** The admin SPA origin; the only browser origin the admin API trusts. */
  ADMIN_ORIGIN?: string;
  /** The customer Worker, read for sanitized capability status. */
  API_URL?: string;
  /** The customer application origin, used for an operator-initiated one-time handoff. */
  APP_URL?: string;
  APP_ENV?: "local" | "preview" | "staging" | "production";
};

type Session = { user: { id: string; email: string; name?: string }; session: { id: string } };

/** The local-only default operator seeded by `trestle dev` (packages/auth/src/local-admin.ts). */
const localAdminEmail = "admin@trestle.local";
type Variables = { correlationId: string; operator: Session["user"]; access: AccessEvaluator; roles: string[]; assurance: SessionAssurance | null; authDatabase: Database };

/** Replaceable in tests. */
export const adminDependencies = {
  session: async (environment: AdminEnvironment, headers: Headers): Promise<Session | null> => await adminAuth(environment).api.getSession({ headers }) as Session | null,
  platformRoles: async (environment: AdminEnvironment, userId: string): Promise<string[]> => await platformRolesFor(platformDatabase(environment), userId),
  assurance: async (database: Database, sessionId: string): Promise<SessionAssurance | null> => await sessionAssurance(database, sessionId),
  enrolledFactor: async (database: Database, userId: string): Promise<"phishing_resistant" | "mfa" | null> => await strongestEnrolledFactor(database, userId),
  factors: async (database: Database, userId: string): Promise<{ totp: boolean; passkeys: number }> => await enrolledFactors(database, userId),
  forwardAuth: async (environment: AdminEnvironment, request: Request): Promise<Response> => await adminAuth(environment).handler(request),
  operationalStatus: async (environment: AdminEnvironment): Promise<unknown> => {
    const response = await fetch(new URL("/api/health/operational", environment.API_URL ?? "http://127.0.0.1:8787"), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`status ${response.status}`);
    return await response.json();
  },
};

/**
 * Better Auth for the admin origin. The same accounts sign in here with their own cookies, but the secret
 * and session table are shared with the customer app, so a customer-app session cookie is also a valid
 * session here. The admin API's minimum sign-in level (see `signInLevel`) is what refuses such a
 * session for an operator with a second factor; APP_ENV is the admin's fail-closed reading.
 */
export function adminAuthEnvironment(environment: AdminEnvironment): AuthEnvironment {
  return { ...environment, APP_ENV: adminEnvironment(environment), BETTER_AUTH_URL: environment.ADMIN_API_URL ?? "http://localhost:8788", WEB_ORIGIN: environment.ADMIN_ORIGIN ?? "http://localhost:42070", EMAIL_DELIVERY_MODE: "local" } as AuthEnvironment;
}

function adminAuth(environment: AdminEnvironment) {
  const settings = adminAuthEnvironment(environment);
  // TOTP, backup codes, and passkeys exist only on the admin; the customer Worker never bundles them.
  return createAuth(settings, { plugins: adminFactorPlugins(settings.WEB_ORIGIN!) });
}

/** Better Auth's own tables (sessions, assurance, factors); one handle serves a request's lookups. */
function authDatabase(environment: AdminEnvironment): Database {
  return createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER);
}

/** The only reader of APP_ENV. Fails closed: a Worker without it is treated as production. */
function adminEnvironment(environment: AdminEnvironment): NonNullable<AdminEnvironment["APP_ENV"]> {
  return environment.APP_ENV ?? "production";
}

function platformConnection(environment: AdminEnvironment): string {
  if (environment.DATABASE_ADMIN_URL) return environment.DATABASE_ADMIN_URL;
  if (adminEnvironment(environment) === "local") return environment.DATABASE_URL;
  throw new AdminConfigurationError("DATABASE_ADMIN_URL is required outside local development");
}

function platformDatabase(environment: AdminEnvironment) {
  return createPlatformDatabase(platformConnection(environment), environment.DATABASE_DRIVER);
}

export class AdminConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminConfigurationError";
  }
}

export const admin = new Hono<{ Bindings: AdminEnvironment; Variables: Variables }>();

admin.use("*", async (context, next) => {
  const supplied = context.req.header("x-correlation-id");
  context.set("correlationId", supplied && /^[A-Za-z0-9._:-]{1,128}$/u.test(supplied) ? supplied : crypto.randomUUID());
  context.header("x-correlation-id", context.get("correlationId"));
  await next();
});

admin.use("/api/*", async (context, next) => cors({ origin: context.env.ADMIN_ORIGIN ?? "http://localhost:42070", credentials: true })(context, next));

admin.get("/api/admin/health/live", (context) => context.json({ status: "ok" }));

// Admin actions are cookie-authenticated, so each one must come from the admin SPA's own origin.
admin.use("/api/admin/*", async (context, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method) && context.req.header("origin") !== (context.env.ADMIN_ORIGIN ?? "http://localhost:42070")) return context.json({ error: "forbidden", reason: "origin_mismatch", message: "Admin actions must come from the admin origin" }, 403);
  await next();
});

const stepUpMessages: Record<AssuranceLevel, string> = {
  phishing_resistant: "Re-authenticate with a passkey to perform this action",
  mfa: "Re-authenticate with a second factor to perform this action",
  password: "Re-authenticate with your password to perform this action",
};

function stepUpRequired(context: AdminContext, requirement: AssuranceRequirement, reason: string) {
  return context.json({ error: "step_up_required", required: requirement.level, maxAgeMinutes: requirement.maxAgeMinutes, reason, message: stepUpMessages[requirement.level] }, 428);
}

/** The seeded local operator (admin/admin) can never operate a deployed platform. */
function localAccountDenied(context: AdminContext, session: Session): Response | null {
  return session.user.email === localAdminEmail && adminEnvironment(context.env) !== "local" ? context.json({ error: "forbidden", reason: "local_account", message: "The default local admin account cannot be used outside local development" }, 403) : null;
}

/**
 * How the admin guards a Better Auth endpoint before forwarding it:
 * - `open`: sign-in and step-up challenges, which have no session yet;
 * - `operator`: a signed-in platform operator;
 * - `operator_if_signed_in`: open without a session (a sign-in challenge), operator-only with one (enrollment);
 * - `step_up`: an operator with fresh evidence at the strongest factor the account has, or a fresh
 *   password before the first enrollment, so neither a stolen password nor a phished TOTP code can
 *   replace stronger factors. Better Auth itself asks only for a password or a session.
 */
type AuthGate = "open" | "operator" | "operator_if_signed_in" | "step_up";

async function authGateDenied(context: AdminContext, gate: AuthGate): Promise<Response | null> {
  if (gate === "open") return null;
  const session = await adminDependencies.session(context.env, context.req.raw.headers);
  if (!session) return gate === "operator_if_signed_in" ? null : context.json({ error: "unauthorized", message: "Sign in to the platform admin" }, 401);
  const local = localAccountDenied(context, session);
  if (local) return local;
  // Tenant membership or ownership never grants access to the admin's factor endpoints.
  if ((await adminDependencies.platformRoles(context.env, session.user.id)).length === 0) return context.json({ error: "forbidden", reason: "no_platform_roles", message: "This account has no platform role" }, 403);
  // The same minimum sign-in level as the admin API. A first enrollment passes: the account has no factor until it is verified.
  const database = authDatabase(context.env);
  const assurance = await adminDependencies.assurance(database, session.session.id);
  const signIn = await signInLevel(context, database, session.user.id, assurance);
  if (signIn.denied) return signIn.denied;
  if (gate !== "step_up") return null;
  const enrolled = signIn.enrolled !== undefined ? signIn.enrolled : await adminDependencies.enrolledFactor(database, session.user.id);
  const requirement: AssuranceRequirement = { level: enrolled ?? "password", maxAgeMinutes: stepUpWindowMinutes };
  const result = meetsRequirement(assurance, requirement, new Date());
  return result.ok ? null : stepUpRequired(context, requirement, result.reason);
}

// Only sign-in, session, sign-out, and the operator's own factors are exposed; sign-up and organization endpoints do not exist here.
const authRoutes: ReadonlyArray<readonly ["GET" | "POST", string, AuthGate]> = [
  ["POST", "/api/auth/sign-in/email", "open"], ["POST", "/api/auth/sign-out", "open"], ["GET", "/api/auth/get-session", "open"],
  ["POST", "/api/auth/two-factor/enable", "step_up"], ["POST", "/api/auth/two-factor/disable", "step_up"], ["POST", "/api/auth/two-factor/generate-backup-codes", "step_up"],
  // With a session, verify-totp completes an enrollment whose enable step was already stepped up.
  ["POST", "/api/auth/two-factor/verify-totp", "operator_if_signed_in"], ["POST", "/api/auth/two-factor/verify-backup-code", "operator_if_signed_in"],
  ["GET", "/api/auth/passkey/list-user-passkeys", "operator"], ["GET", "/api/auth/passkey/generate-register-options", "step_up"], ["POST", "/api/auth/passkey/verify-registration", "step_up"],
  ["POST", "/api/auth/passkey/delete-passkey", "step_up"], ["GET", "/api/auth/passkey/generate-authenticate-options", "open"], ["POST", "/api/auth/passkey/verify-authentication", "open"],
];
for (const [method, path, gate] of authRoutes) {
  admin.on(method, path, async (context) => (await authGateDenied(context, gate)) ?? await adminDependencies.forwardAuth(context.env, context.req.raw));
}

/**
 * The minimum sign-in level for every admin API request, in every environment: an operator with a second
 * factor or passkey must have signed in with one. Otherwise a password alone (an admin sign-in that skipped
 * a passkey, or a replayed customer-app session, which never had a factor challenge) would read the admin.
 * The factor lookup is skipped when the session already proves a second factor.
 */
async function signInLevel(context: AdminContext, database: Database, userId: string, assurance: SessionAssurance | null): Promise<{ denied: Response | null; enrolled?: AssuranceLevel | null }> {
  if (assurance && assuranceRank[assurance.level] >= assuranceRank.mfa) return { denied: null };
  const enrolled = await adminDependencies.enrolledFactor(database, userId);
  const result = meetsSignInLevel(assurance, enrolled);
  if (result.ok) return { denied: null, enrolled };
  return { denied: context.json({ error: "step_up_required", required: "mfa", reason: result.reason, scope: "session", message: "Sign in with your second factor or passkey" }, 428), enrolled };
}

/** Platform authentication and authority for every admin API route. */
admin.use("/api/admin/*", async (context, next) => {
  const policy = adminPolicyFor(context.req.method, context.req.path);
  if (policy?.public) return await next();
  const log = createLogger({ correlationId: context.get("correlationId"), surface: "admin" }, undefined, { secretValues: loggerSecretsFromEnvironment(context.env) });
  try {
    const session = await adminDependencies.session(context.env, context.req.raw.headers);
    if (!session) return context.json({ error: "unauthorized", message: "Sign in to the platform admin" }, 401);
    const local = localAccountDenied(context, session);
    if (local) return local;
    const roles = await adminDependencies.platformRoles(context.env, session.user.id);
    const { access, unknownRoles } = platformAccess(session.user.id, roles);
    if (unknownRoles.length) log.warn("admin.roles.unknown", { unknownRoles });
    // Tenant membership or ownership never grants platform access.
    if (roles.length === 0) return context.json({ error: "forbidden", reason: "no_platform_roles", message: "This account has no platform role" }, 403);
    if (!policy) return context.json({ error: "not_found" }, 404);
    const database = authDatabase(context.env);
    const assurance = await adminDependencies.assurance(database, session.session.id);
    const signIn = await signInLevel(context, database, session.user.id, assurance);
    if (signIn.denied) return signIn.denied;
    context.set("assurance", assurance);
    context.set("authDatabase", database);
    if (policy.permission) access.require({ permission: policy.permission });
    // Every platform change needs recent authentication at the environment's level; reads, and the few
    // actions the view registry marks `stepUp: false` (a read over POST, ending a support session), do not.
    const change = Boolean(policy.permission) && context.req.method !== "GET" && context.req.method !== "HEAD" && !stepUpExemptRoutes.has(`${policy.method} ${policy.path}`);
    if (change) {
      const requirement = platformAssuranceRequirement(policy.permission!, adminEnvironment(context.env));
      const result = meetsRequirement(assurance, requirement, new Date());
      if (!result.ok) return stepUpRequired(context, requirement, result.reason);
    }
    context.set("operator", session.user);
    context.set("access", access);
    context.set("roles", roles);
    await next();
  } catch (error) {
    if (error instanceof AccessDeniedError) return context.json(publicDenial(error.decision), error.status);
    throw error;
  }
});

admin.get("/api/admin/session", async (context) => {
  const access = context.get("access");
  const operator = context.get("operator");
  const environment = adminEnvironment(context.env);
  const database = platformDatabase(context.env);
  // Display context only: authority is checked on every request, so a failed lookup shows no support banner rather than failing sign-in.
  const log = createLogger({ correlationId: context.get("correlationId"), surface: "admin" }, undefined, { secretValues: loggerSecretsFromEnvironment(context.env) });
  const [factors, sessions, organizations, status] = await Promise.all([
    // Which step-up paths the shell may offer; on the same auth database handle as the request's assurance lookup.
    adminDependencies.factors(context.get("authDatabase"), operator.id),
    listSupportSessions(database, { operatorId: operator.id, limit: 5 }).catch((error: unknown) => { log.warn("admin.session.support_lookup_failed", { errorName: error instanceof Error ? error.name : "unknown" }); return []; }),
    supportableOrganizations(database).catch(() => []),
    adminDependencies.operationalStatus(context.env).catch(() => undefined),
  ]);
  const now = Date.now();
  const open = sessions.find((session) => !session.endedAt && session.expiresAt.getTime() > now);
  const assurance = context.get("assurance");
  return context.json({
    operator: { id: operator.id, email: operator.email, name: operator.name ?? operator.email },
    roles: context.get("roles"),
    permissions: access.permitted(),
    environment,
    capabilities: shellCapabilities(status, environment),
    assurance: assurance ? { level: assurance.level, method: assurance.method, verifiedAt: assurance.verifiedAt.toISOString() } : null,
    // Null when actions will ask for step-up regardless: no evidence, or evidence below what actions need here.
    factors,
    stepUpRequiredAfter: assurance && assuranceRank[assurance.level] >= assuranceRank[actionAssuranceLevel(environment)] ? new Date(assurance.verifiedAt.getTime() + stepUpWindowMinutes * 60_000).toISOString() : null,
    supportSession: open ? {
      id: open.id, operatorId: open.operatorId, organizationId: open.organizationId, targetUserId: open.targetUserId,
      organizationName: organizations.find((item) => item.organizationId === open.organizationId)?.organizationName ?? open.organizationId,
      reason: open.reason, ticket: null, profile: "Read-only support",
      startedAt: open.startedAt.toISOString(), expiresAt: open.expiresAt.toISOString(), endedAt: null, endedBy: null,
    } : null,
    views: adminViews.map((view) => ({ id: view.id, path: view.path, label: view.label, group: view.group, capability: view.capability ?? null, allowed: access.check({ permission: view.permission }) })),
  });
});

admin.get("/api/admin/openapi.json", (context) => context.json(buildOpenApi(adminRoutePolicies, [], { title: "__TRESTLE_PROJECT_NAME__ platform admin API", version: "1.0.0", exposure: "all" }).document));

admin.get("/api/admin/overview", async (context) => context.json(await overview(platformDatabase(context.env), { includeAudit: context.get("access").check({ permission: "platform.audit.read" }) })));

type AdminContext = Context<{ Bindings: AdminEnvironment; Variables: Variables }>;

/** Every platform action names its operator, reason, environment, and correlation ID for audit_event. */
async function actionContext(context: AdminContext, body?: { reason?: unknown }): Promise<PlatformChangeContext> {
  body ??= await context.req.json().catch(() => ({})) as { reason?: unknown };
  if (typeof body.reason !== "string") throw new PlatformOperationError("invalid", "A reason is required");
  return { actor: { type: "platform_operator", id: context.get("operator").id }, reason: body.reason, environment: adminEnvironment(context.env), correlationId: context.get("correlationId") };
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

admin.get("/api/admin/operations/outbox", async (context) => {
  const database = platformDatabase(context.env);
  const [events, counts] = await Promise.all([listDeadOutboxEvents(database, { limit: Number(context.req.query("limit") ?? 50) }), outboxStatusCounts(database)]);
  return context.json({ counts, dead: events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })) });
});

admin.get("/api/admin/organizations", async (context) => {
  const organizations = await listPlatformOrganizations(platformDatabase(context.env), { query: context.req.query("q") ?? "" });
  return context.json({ organizations: organizations.map((item) => ({ ...item, slug: item.slug ?? "", createdAt: item.createdAt.toISOString() })) });
});

admin.post("/api/admin/operations/outbox/:id/redrive", async (context) => {
  await redriveOutboxEvent(platformDatabase(context.env), context.req.param("id"), await actionContext(context));
  return context.json({ redriven: true, correlationId: context.get("correlationId") });
});

admin.get("/api/admin/operations/webhooks", async (context) => {
  const database = platformDatabase(context.env);
  const [endpoints, failed] = await Promise.all([listPlatformWebhookEndpoints(database), listFailedWebhookDeliveries(database)]);
  return context.json({
    endpoints: endpoints.map((endpoint) => ({ ...endpoint, updatedAt: endpoint.updatedAt.toISOString() })),
    failedDeliveries: failed.map((delivery) => ({ ...delivery, completedAt: iso(delivery.completedAt) })),
  });
});

admin.post("/api/admin/operations/webhooks/:organizationId/endpoints/:endpointId/disable", async (context) => {
  await disableWebhookEndpoint(platformDatabase(context.env), { organizationId: context.req.param("organizationId"), endpointId: context.req.param("endpointId") }, await actionContext(context));
  return context.json({ disabled: true, correlationId: context.get("correlationId") });
});

admin.post("/api/admin/operations/webhooks/:organizationId/deliveries/:deliveryId/replay", async (context) => {
  const replay = await replayWebhookDelivery(platformDatabase(context.env), { organizationId: context.req.param("organizationId"), deliveryId: context.req.param("deliveryId") }, await actionContext(context));
  return context.json({ replayed: true, replayDeliveryId: replay.deliveryId, created: replay.created, correlationId: context.get("correlationId") });
});

admin.get("/api/admin/commercial/subscriptions", async (context) => {
  const rows = await listPlatformSubscriptions(platformDatabase(context.env));
  return context.json({ subscriptions: rows.map((row) => ({ ...row, currentPeriodEnd: iso(row.currentPeriodEnd) })) });
});

admin.get("/api/admin/commercial/subscriptions/:organizationId", async (context) => {
  const detail = await platformCommercialDetail(platformDatabase(context.env), context.req.param("organizationId"));
  return context.json({
    subscription: detail.subscription && { ...detail.subscription, currentPeriodStart: iso(detail.subscription.currentPeriodStart), currentPeriodEnd: iso(detail.subscription.currentPeriodEnd) },
    planEntitlements: detail.planEntitlements,
    overrides: detail.overrides.map((override) => ({ ...override, effectiveAt: override.effectiveAt.toISOString(), expiresAt: iso(override.expiresAt), removedAt: iso(override.removedAt) })),
    entitlementCatalog: Object.entries(featureDefinitions).map(([code, definition]) => ({ code, description: definition.description })),
  });
});

admin.post("/api/admin/commercial/subscriptions/:organizationId/overrides", async (context) => {
  const body = await context.req.json().catch(() => ({})) as { entitlement?: unknown; enabled?: unknown; expiresAt?: unknown; reason?: unknown };
  // Only entitlements the application defines can be overridden.
  if (typeof body.entitlement !== "string" || !Object.hasOwn(featureDefinitions, body.entitlement)) throw new PlatformOperationError("invalid", "Choose an entitlement the application defines");
  if (typeof body.enabled !== "boolean") throw new PlatformOperationError("invalid", "Choose whether the override grants or denies the entitlement");
  const expiresAt = body.expiresAt === undefined || body.expiresAt === null ? undefined : new Date(String(body.expiresAt));
  if (expiresAt && !Number.isFinite(expiresAt.getTime())) throw new PlatformOperationError("invalid", "The expiry is not a valid date");
  const result = await grantEntitlementOverride(platformDatabase(context.env), { organizationId: context.req.param("organizationId"), entitlement: body.entitlement, enabled: body.enabled, ...(expiresAt ? { expiresAt } : {}) }, await actionContext(context, body));
  return context.json({ granted: true, effectiveAt: result.effectiveAt.toISOString(), correlationId: context.get("correlationId") });
});

admin.post("/api/admin/commercial/subscriptions/:organizationId/overrides/:entitlement/revoke", async (context) => {
  await revokeEntitlementOverride(platformDatabase(context.env), { organizationId: context.req.param("organizationId"), entitlement: context.req.param("entitlement") }, await actionContext(context));
  return context.json({ revoked: true, correlationId: context.get("correlationId") });
});

admin.get("/api/admin/organizations/:organizationId", async (context) => {
  const database = platformDatabase(context.env);
  const detail = await platformOrganizationDetail(database, context.req.param("organizationId"));
  if (!detail) throw new PlatformOperationError("not_found", "Organization not found");
  const regional = await organizationRegionalOverrides(database, detail.organization.id).catch(() => null);
  return context.json({
    organization: { ...detail.organization, slug: detail.organization.slug ?? "", createdAt: detail.organization.createdAt.toISOString() },
    members: detail.members.map((entry) => ({ ...entry, joinedAt: entry.joinedAt.toISOString() })),
    regional,
  });
});

admin.get("/api/admin/users", async (context) => {
  const users = await listPlatformUsers(platformDatabase(context.env), { query: context.req.query("q") ?? "" });
  return context.json({ users: users.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })) });
});

const auditJson = (event: Awaited<ReturnType<typeof platformAuditEvent>> & object) => ({ ...event, occurredAt: event.occurredAt.toISOString() });

admin.get("/api/admin/audit", async (context) => {
  const query = (name: string) => context.req.query(name) || undefined;
  const result = await listPlatformAuditEvents(platformDatabase(context.env), {
    ...(query("organizationId") ? { organizationId: query("organizationId")! } : {}), ...(query("actor") ? { actor: query("actor")! } : {}),
    ...(query("name") ? { name: query("name")! } : {}), ...(query("correlation") ? { correlationId: query("correlation")! } : {}),
    page: Number(query("page") ?? 1), pageSize: Number(query("pageSize") ?? 50),
  });
  return context.json({ ...result, events: result.events.map(auditJson) });
});

admin.get("/api/admin/audit/:id", async (context) => {
  const event = await platformAuditEvent(platformDatabase(context.env), context.req.param("id"));
  if (!event) throw new PlatformOperationError("not_found", "Audit event not found");
  return context.json({ event: auditJson(event) });
});

admin.get("/api/admin/platform-roles", async (context) => {
  const assignments = await listPlatformRoleAssignments(platformDatabase(context.env), { history: context.req.query("history") === "1" });
  return context.json({
    assignments: assignments.map((entry) => ({ ...entry, grantedAt: entry.grantedAt.toISOString(), revokedAt: iso(entry.revokedAt) })),
    roles: platformRoles.list().map((role) => ({ key: role.key, name: role.name, description: role.description, permissions: role.permissions })),
  });
});

admin.post("/api/admin/platform-roles", async (context) => {
  const body = await context.req.json().catch(() => ({})) as { userId?: unknown; role?: unknown; reason?: unknown };
  if (typeof body.userId !== "string" || !body.userId) throw new PlatformOperationError("invalid", "Choose a user");
  if (typeof body.role !== "string" || !platformRoles.get(body.role)) throw new PlatformOperationError("invalid", "Choose a platform role the application defines");
  await grantPlatformRole(platformDatabase(context.env), { userId: body.userId, role: body.role }, await actionContext(context, body));
  return context.json({ granted: true, correlationId: context.get("correlationId") });
});

admin.post("/api/admin/platform-roles/:userId/:role/revoke", async (context) => {
  // An operator cannot remove their own platform authority; another administrator must.
  if (context.req.param("userId") === context.get("operator").id) throw new PlatformOperationError("invalid", "Ask another security administrator to revoke your own platform role");
  await revokePlatformRole(platformDatabase(context.env), { userId: context.req.param("userId"), role: context.req.param("role") }, await actionContext(context));
  return context.json({ revoked: true, correlationId: context.get("correlationId") });
});

admin.get("/api/admin/access/role-assignments", async (context) => {
  const plane = context.req.query("plane");
  if (plane !== "organization" && plane !== "application") throw new PlatformOperationError("invalid", "Choose the organization or application plane");
  return context.json({ assignments: await listPlatformRoleHolders(platformDatabase(context.env), plane, context.req.query("role") || undefined) });
});

admin.get("/api/admin/service-accounts", async (context) => {
  const accounts = await listPlatformServiceAccounts(platformDatabase(context.env), context.req.query("organizationId") || undefined);
  return context.json({ serviceAccounts: accounts.map((account) => ({ ...account, createdAt: account.createdAt.toISOString() })) });
});

/**
 * Explains a principal's access in one organization with the same policy the
 * customer Worker enforces: each plane resolves only from its own assignments,
 * and entitlements come from the plan and active overrides. It never performs
 * the protected action.
 */
admin.post("/api/admin/access/explain", async (context) => {
  const body = await context.req.json().catch(() => ({})) as { organizationId?: unknown; principal?: { type?: unknown; id?: unknown }; permission?: unknown; entitlement?: unknown };
  const type = body.principal?.type;
  if (typeof body.organizationId !== "string" || (type !== "user" && type !== "service_account") || typeof body.principal?.id !== "string") throw new PlatformOperationError("invalid", "Choose an organization and an identity");
  if (body.permission !== undefined && (typeof body.permission !== "string" || !permissions.has(body.permission))) throw new PlatformOperationError("invalid", "Choose a registered permission");
  if (body.entitlement !== undefined && (typeof body.entitlement !== "string" || !Object.hasOwn(featureDefinitions, body.entitlement))) throw new PlatformOperationError("invalid", "Choose an entitlement the application defines");
  const database = platformDatabase(context.env);
  const [subject, commercial] = await Promise.all([
    platformAccessAssignments(database, body.organizationId, { type, id: body.principal.id }),
    platformCommercialDetail(database, body.organizationId),
  ]);
  if (!subject) throw new PlatformOperationError("not_found", "That identity is not found in this organization");
  const organization = organizationRoles.resolve(subject.organizationRoles);
  const application = applicationRoles.resolve(subject.applicationRoles);
  const now = new Date();
  const entitlements = new Entitlements(new Set(commercial.planEntitlements), {
    ...(commercial.subscription ? { plan: commercial.subscription.plan, planVersion: commercial.subscription.planVersion } : {}), now,
    overrides: commercial.overrides.filter((override) => !override.removedAt).map((override) => ({ code: override.entitlement, enabled: override.enabled, reason: override.reason, authorId: override.authorId, effectiveAt: override.effectiveAt, ...(override.expiresAt ? { expiresAt: override.expiresAt } : {}) })),
  });
  const decision = evaluateAccess(permissions, {
    principal: { type, id: body.principal.id, label: subject.principalName },
    tenant: { organizationId: body.organizationId, label: subject.organizationName },
    authority: subject.member ? { organization: organization.permissions, application: application.permissions } : {},
    assignments: { organization: subject.organizationRoles, application: subject.applicationRoles },
    entitlements: { get: (code) => { const resolved = entitlements.resolve(code); return { code, enabled: resolved.enabled, source: resolved.source, ...(resolved.inheritedFrom ? { inheritedFrom: resolved.inheritedFrom } : {}) }; } },
    ...(subject.status && subject.status !== "active" ? { constraints: [{ name: "service account status", expected: "active", actual: subject.status, satisfied: false }] } : {}),
  }, { ...(typeof body.permission === "string" ? { permission: body.permission } : {}), ...(typeof body.entitlement === "string" ? { entitlement: body.entitlement } : {}) });
  return context.json({ decision, explanation: formatAccessExplanation(decision) });
});

admin.get("/api/admin/email", async (context) => {
  const events = await listPlatformEmailEvents(platformDatabase(context.env), { ...(context.req.query("status") ? { status: context.req.query("status")! } : {}) });
  return context.json({ events: events.map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString(), receivedAt: event.receivedAt.toISOString() })) });
});

admin.get("/api/admin/support/sessions", async (context) => {
  const database = platformDatabase(context.env);
  const [sessions, organizations] = await Promise.all([listSupportSessions(database, { operatorId: context.get("operator").id }), supportableOrganizations(database)]);
  return context.json({
    sessions: sessions.map((session) => ({ ...session, startedAt: session.startedAt.toISOString(), expiresAt: session.expiresAt.toISOString(), endedAt: iso(session.endedAt) })),
    organizations,
  });
});

admin.post("/api/admin/support/sessions", async (context) => {
  const body = await context.req.json().catch(() => ({})) as { organizationId?: unknown; targetUserId?: unknown; durationMinutes?: unknown; reason?: unknown };
  if (typeof body.organizationId !== "string") throw new PlatformOperationError("invalid", "Choose an organization");
  if (body.targetUserId !== undefined && (typeof body.targetUserId !== "string" || !body.targetUserId.trim())) throw new PlatformOperationError("invalid", "Choose a member to view");
  const session = await startSupportSession(platformDatabase(context.env), { organizationId: body.organizationId, ...(typeof body.targetUserId === "string" ? { targetUserId: body.targetUserId } : {}), durationMinutes: typeof body.durationMinutes === "number" ? body.durationMinutes : 30 }, await actionContext(context, body));
  return context.json({ id: session.id, organizationId: session.organizationId, expiresAt: session.expiresAt.toISOString(), correlationId: context.get("correlationId") }, 201);
});

admin.post("/api/admin/support/sessions/:id/handoff", async (context) => {
  const body = await context.req.json().catch(() => ({})) as { reason?: unknown };
  const change = await actionContext(context, body);
  const session = await activeSupportSession(platformDatabase(context.env), context.req.param("id"), context.get("operator").id);
  if (!session?.targetUserId) return context.json({ error: "forbidden", reason: "member_bound_session_required" }, 403);
  const appUrl = context.env.APP_URL ?? (adminEnvironment(context.env) === "local" ? "http://localhost:42069" : undefined);
  let appOrigin: string;
  try {
    const parsed = new URL(appUrl ?? "");
    const local = adminEnvironment(context.env) === "local" && parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
    if (!appUrl || (!local && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== appUrl.replace(/\/$/u, "")) throw new Error("invalid origin");
    appOrigin = parsed.origin;
  } catch { throw new AdminConfigurationError("APP_URL must be a bare HTTPS customer app origin (localhost HTTP is local-only)"); }
  const token = await mintSupportHandoff(platformDatabase(context.env), session, change);
  const url = new URL("/support/view", appOrigin);
  // The fragment stays out of Worker/CDN request logs and Referer headers. The app removes it before exchange.
  url.hash = `handoff=${token}`;
  context.header("Cache-Control", "no-store");
  return context.json({ url: url.toString() });
});

admin.get("/api/admin/support/sessions/:id/organization", async (context) => {
  const database = platformDatabase(context.env);
  const operator = context.get("operator");
  // Tenant data is readable only inside the operator's own open, unexpired session.
  const session = await activeSupportSession(database, context.req.param("id"), operator.id);
  if (!session) return context.json({ error: "forbidden", reason: "support_session_required", message: "Start a support session for this organization first" }, 403);
  const view = await supportOrganizationView(database, session, { actor: { type: "platform_operator", id: operator.id }, environment: adminEnvironment(context.env), correlationId: context.get("correlationId") });
  return context.json({
    ...view,
    organization: view.organization && { ...view.organization, createdAt: view.organization.createdAt.toISOString() },
    members: view.members.map((person) => ({ ...person, joinedAt: person.joinedAt.toISOString() })),
    subscription: view.subscription && { ...view.subscription, currentPeriodEnd: iso(view.subscription.currentPeriodEnd) },
    recentAudit: view.recentAudit.map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString() })),
  });
});

admin.post("/api/admin/support/sessions/:id/end", async (context) => {
  const body = await context.req.json().catch(() => ({})) as { reason?: unknown };
  await endSupportSession(platformDatabase(context.env), context.req.param("id"), await actionContext(context, { reason: typeof body.reason === "string" ? body.reason : "" }));
  return context.json({ ended: true, correlationId: context.get("correlationId") });
});

admin.get("/api/admin/security/api-keys", async (context) => {
  const keys = await listPlatformApiKeys(platformDatabase(context.env), { activeOnly: context.req.query("active") === "true" });
  return context.json({ keys: keys.map((key) => ({ ...key, createdAt: key.createdAt.toISOString(), expiresAt: iso(key.expiresAt), revokedAt: iso(key.revokedAt) })) });
});

admin.post("/api/admin/security/api-keys/:organizationId/:keyId/revoke", async (context) => {
  await platformRevokeApiKey(platformDatabase(context.env), { organizationId: context.req.param("organizationId"), keyId: context.req.param("keyId") }, await actionContext(context));
  return context.json({ revoked: true, correlationId: context.get("correlationId") });
});

admin.get("/api/admin/operations/artifacts", async (context) => {
  // Pending uploads older than a day are stale; the artifact maintenance job cleans them up.
  return context.json(await artifactOperations(platformDatabase(context.env), { staleBefore: new Date(Date.now() - 86_400_000) }));
});

type ShellCapabilityState = "disabled" | "declared" | "configured";
type ReportedCapability = { configured?: unknown; enabled?: unknown; mode?: unknown };

/**
 * Capability lifecycle for the admin shell. Queues, R2, and Workflows exist only
 * when declared in .trestle/project.yaml, and the customer Worker carries their
 * bindings only then, so an absent binding means the capability is not
 * declared and its views are hidden. Email and billing are always part of the
 * application, so an unconfigured provider needs setup rather than hiding.
 */
export function shellCapabilities(status: unknown, environment: string) {
  const reported = (status && typeof status === "object" ? (status as { capabilities?: Record<string, ReportedCapability> }).capabilities : undefined) ?? {};
  const repair = `pnpm exec trestle doctor --env ${environment}`;
  const entry = (id: string, label: string, state: ShellCapabilityState, source?: ReportedCapability) => {
    const mode = typeof source?.mode === "string" && /^[a-z0-9-]{1,32}$/u.test(source.mode) ? source.mode : undefined;
    return { id, label, state, healthy: state !== "declared", ...(mode ? { mode } : {}), ...(state === "declared" ? { message: `${label} is not configured for ${environment}.`, repair } : {}) };
  };
  const always = (id: string, label: string, source: ReportedCapability | undefined) => entry(id, label, source?.configured === true ? "configured" : "declared", source);
  const optional = (id: string, label: string, source: ReportedCapability | undefined, declared: boolean) => entry(id, label, !declared ? "disabled" : source?.configured === true ? "configured" : "declared", source);
  return [
    entry("admin", "Platform admin", "configured"),
    always("email", "Email", reported.email),
    always("payments", "Billing", reported.billing),
    optional("queues", "Queues", reported.queues, reported.queues?.configured === true),
    optional("r2", "Artifacts (R2)", reported.artifacts, reported.artifacts?.configured === true),
    optional("workflows", "Workflows", reported.workflows, reported.workflows?.enabled === true),
  ];
}

const capabilityLabels: Record<AdminCapability, string> = { database: "Database", email: "Email", billing: "Billing", queues: "Queues", artifacts: "Artifacts", workflows: "Workflows" };

/** Sanitized: configured flags and modes only, never values. Unconfigured capabilities carry a setup command. */
export function capabilityGuidance(status: unknown, environment: string) {
  const reported = (status && typeof status === "object" ? (status as { capabilities?: Record<string, { configured?: unknown; mode?: unknown; enabled?: unknown }> }).capabilities : undefined) ?? {};
  const repair = `pnpm exec trestle doctor --env ${environment}`;
  return (Object.keys(capabilityLabels) as AdminCapability[]).map((id) => {
    const entry = reported[id];
    if (!entry) return { id, label: capabilityLabels[id], state: "unknown" as const, repair };
    const configured = entry.configured === true;
    const mode = typeof entry.mode === "string" && /^[a-z0-9-]{1,32}$/u.test(entry.mode) ? entry.mode : undefined;
    return { id, label: capabilityLabels[id], state: configured ? "configured" as const : "not_configured" as const, ...(mode ? { mode } : {}), ...(configured ? {} : { repair }) };
  });
}

admin.get("/api/admin/health", async (context) => {
  const environment = adminEnvironment(context.env);
  const reachable = await databaseReachable(platformDatabase(context.env));
  let application: { reachable: boolean; capabilities: ReturnType<typeof capabilityGuidance> };
  try {
    application = { reachable: true, capabilities: capabilityGuidance(await adminDependencies.operationalStatus(context.env), environment) };
  } catch {
    application = { reachable: false, capabilities: capabilityGuidance(undefined, environment) };
  }
  return context.json({
    environment,
    platformDatabase: { reachable, distinctLogin: Boolean(context.env.DATABASE_ADMIN_URL) },
    application,
  });
});

/** What generated shared-resource editors (`trestle generate resource --shared`) need to register their routes. */
export type AdminResourceHelpers = Readonly<{ platformDatabase: typeof platformDatabase; actionContext: typeof actionContext }>;
const adminResourceHelpers: AdminResourceHelpers = { platformDatabase, actionContext };
// trestle:admin-resource-routes
void adminResourceHelpers;

const operationStatus = { invalid: 400, not_found: 404, conflict: 409 } as const;

admin.onError((error, context) => {
  if (error instanceof AdminConfigurationError) return context.json({ error: "not_configured", message: error.message, repair: `pnpm exec trestle doctor --env ${adminEnvironment(context.env)}` }, 503);
  if (error instanceof PlatformOperationError || error instanceof MachineAccessError || error instanceof PlatformRoleError) return context.json({ error: error.code, message: error.message, correlationId: context.get("correlationId") }, operationStatus[error.code as keyof typeof operationStatus] ?? 400);
  createLogger({ correlationId: context.get("correlationId"), surface: "admin" }, undefined, { secretValues: loggerSecretsFromEnvironment(context.env) }).error("admin.request.failed", { errorName: error.name });
  return context.json({ error: "internal_error", message: "The request could not be completed" }, 500);
});

export default { fetch: admin.fetch.bind(admin) };
