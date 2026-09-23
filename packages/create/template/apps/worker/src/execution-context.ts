import { createAuth, type AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import {
  AccessDeniedError, AccessEvaluator, apiKeyStatus, applicationRoles, bearerApiKey, defaultResourcePolicy, organizationRoles, parseApiKey, parseMembershipRoles, permissions, policyFor,
  publicDenial, verifyApiKey, type ApplicationEnvironment, type HttpMethod,
} from "@__TRESTLE_PROJECT_NAME__/authz";
import { createLogger, createMetrics, type EntitlementDecision, type Entitlements, type ExecutionContext } from "@__TRESTLE_PROJECT_NAME__/context";
import { activeApplicationRoles, createDatabase, createTenantDatabase, member, outboxApplicationConnectionString, resolveApiKey, type ResolvedApiKey } from "@__TRESTLE_PROJECT_NAME__/db";
import type { SubscriptionSummary } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { createEventPublisher, type EventPublisher } from "./events.js";
import { createServices, type AppServices } from "./services.js";

type AuthenticatedSession = {
  user: { id: string; email: string };
  session: { activeOrganizationId?: string | null };
};

type Membership = { role: string };

export type AppExecutionContext = ExecutionContext<
  ReturnType<typeof createTenantDatabase>,
  AppServices,
  AccessEvaluator
> & Readonly<{ events: EventPublisher }> & {
  /** Role assignments considered for this request, per plane, for explanation. */
  assignments: Readonly<{ organization: readonly string[]; application: readonly string[] }>;
};

export type AppVariables = { execution: AppExecutionContext; correlationId: string; requestStartedAt: number };

export class ExecutionContextError extends Error {
  constructor(readonly code: "unauthorized" | "tenant_required" | "not_found", message: string, readonly status: 401 | 400 | 404) {
    super(message);
    this.name = "ExecutionContextError";
  }
}

type ContextDependencies = {
  getSession: (headers: Headers, environment: AuthEnvironment) => Promise<AuthenticatedSession | null>;
  findMembership: (userId: string, organizationId: string, environment: AuthEnvironment) => Promise<Membership | null>;
  /** Tenant-scoped application-role assignments, stored separately from organization membership. */
  loadApplicationRoles: (userId: string, organizationId: string, environment: AuthEnvironment) => Promise<string[]>;
  findSubscription: (organizationId: string, environment: AuthEnvironment) => Promise<SubscriptionSummary | null>;
  /** Looks an API key up by public ID before any tenant is known (the SECURITY DEFINER resolver). */
  resolveApiKey: (publicId: string, environment: AuthEnvironment) => Promise<ResolvedApiKey | null>;
};

const defaults: ContextDependencies = {
  getSession: async (headers, environment) => await createAuth(environment).api.getSession({ headers }) as AuthenticatedSession | null,
  findMembership: async (userId, organizationId, environment) => {
    const [record] = await createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER)
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
      .limit(1);
    return record ?? null;
  },
  // Read on the restricted tenant connection: forced RLS bounds the rows to this organization.
  loadApplicationRoles: async (userId, organizationId, environment) => await activeApplicationRoles(createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId), organizationId, userId),
  findSubscription: async (organizationId, environment) => await createServices(environment).billing.getSubscription(organizationId),
  // The resolver is granted only to trestle_app, so the lookup runs as the restricted role.
  resolveApiKey: async (publicId, environment) => await resolveApiKey(createDatabase(outboxApplicationConnectionString(environment.DATABASE_URL), environment.DATABASE_DRIVER), publicId),
};

function correlationId(headers: Headers): string {
  const supplied = headers.get("x-correlation-id");
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/u.test(supplied) ? supplied : crypto.randomUUID();
}

function entitlementsFrom(subscription: SubscriptionSummary | null): Entitlements {
  const decisions = new Map((subscription?.effectiveEntitlements ?? subscription?.entitlements.map((code) => ({ code, enabled: true, source: "plan" as const, inheritedFrom: `${subscription.plan}@${subscription.planVersion}`, effectiveAt: new Date() })) ?? []).map((decision) => [decision.code, decision]));
  return {
    resolve: (code): EntitlementDecision => decisions.get(code) ?? { code, enabled: false, source: "default", effectiveAt: new Date(0) },
    has: (code) => decisions.get(code)?.enabled ?? false,
  };
}

const unauthorized = () => new ExecutionContextError("unauthorized", "Authentication is required", 401);

/**
 * A request carrying `Authorization: Bearer tr_…` acts as the key's service
 * account in the key's own organization. Its authority is the service
 * account's application roles narrowed to the key's scopes; it never holds
 * organization or platform authority. Every failure is the same generic 401.
 */
async function resolveApiKeyContext(token: string, headers: Headers, environment: AuthEnvironment, dependencies: ContextDependencies, suppliedCorrelationId?: string): Promise<AppExecutionContext> {
  const parsed = parseApiKey(token);
  if (!parsed) throw unauthorized();
  const key = await dependencies.resolveApiKey(parsed.publicId, environment);
  if (!key || !(await verifyApiKey(token, key.verifier))) throw unauthorized();
  const clock = { now: () => new Date() };
  const appEnvironment = (environment.APP_ENV ?? "local") as ApplicationEnvironment;
  const status = apiKeyStatus(key, { now: clock.now(), environment: appEnvironment });
  const correlation = { correlationId: suppliedCorrelationId ?? correlationId(headers) };
  const log = createLogger({ correlationId: correlation.correlationId, serviceAccountId: key.serviceAccountId, organizationId: key.organizationId });
  if (status !== "active") {
    log.warn("auth.api_key.rejected", { keyId: parsed.publicId, status });
    throw unauthorized();
  }
  const organizationId = key.organizationId;
  const requested = headers.get("x-trestle-tenant");
  if (requested && requested !== organizationId) throw new ExecutionContextError("not_found", "Organization not found", 404);
  const entitlements = entitlementsFrom(await dependencies.findSubscription(organizationId, environment));
  const application = applicationRoles.resolve(key.applicationRoles);
  if (application.unknownRoles.length) log.warn("auth.roles.unknown", { unknownRoles: application.unknownRoles });
  const scopes = new Set(key.scopes);
  const access = new AccessEvaluator(permissions, {
    principal: { type: "service_account", id: key.serviceAccountId },
    tenant: { organizationId },
    authority: { application: application.permissions },
    assignments: { organization: [], application: key.applicationRoles },
    scopes,
    credential: { id: parsed.publicId, status },
    entitlements: { get: (code) => { const decision = entitlements.resolve(code); return { code, enabled: decision.enabled, source: decision.source, ...(decision.inheritedFrom ? { inheritedFrom: decision.inheritedFrom } : {}) }; } },
  });
  log.info("auth.context.resolved", { credential: parsed.publicId, applicationRoles: key.applicationRoles });
  return {
    principal: { id: key.serviceAccountId, kind: "service_account", credentialId: parsed.publicId },
    tenant: { organizationId },
    permissions: new Set([...application.permissions.keys()].filter((code) => scopes.has(code))),
    assignments: { organization: [], application: key.applicationRoles },
    entitlements,
    access,
    correlation,
    data: createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId),
    events: createEventPublisher({ organizationId, correlationId: correlation.correlationId, clock }),
    log,
    metrics: createMetrics(log),
    clock,
    features: { enabled: (name) => entitlements.has(name) },
    services: createServices(environment),
  };
}

export async function resolveExecutionContext(
  headers: Headers,
  environment: AuthEnvironment,
  dependencies: ContextDependencies = defaults,
  suppliedCorrelationId?: string,
): Promise<AppExecutionContext> {
  const token = bearerApiKey(headers.get("authorization"));
  if (token) return await resolveApiKeyContext(token, headers, environment, dependencies, suppliedCorrelationId);
  const session = await dependencies.getSession(headers, environment);
  if (!session) throw new ExecutionContextError("unauthorized", "Authentication is required", 401);
  const organizationId = headers.get("x-trestle-tenant") ?? session.session.activeOrganizationId;
  if (!organizationId) throw new ExecutionContextError("tenant_required", "An organization must be selected", 400);
  const membership = await dependencies.findMembership(session.user.id, organizationId, environment);
  if (!membership) throw new ExecutionContextError("not_found", "Organization not found", 404);
  const [subscription, applicationAssignments] = await Promise.all([
    dependencies.findSubscription(organizationId, environment),
    dependencies.loadApplicationRoles(session.user.id, organizationId, environment),
  ]);
  const entitlements = entitlementsFrom(subscription);
  // Each plane resolves only from its own assignments; nothing flows between them.
  const organizationAssignments = parseMembershipRoles(membership.role);
  const organization = organizationRoles.resolve(organizationAssignments);
  const application = applicationRoles.resolve(applicationAssignments);
  const correlation = { correlationId: suppliedCorrelationId ?? correlationId(headers) };
  const clock = { now: () => new Date() };
  const log = createLogger({ correlationId: correlation.correlationId, userId: session.user.id, organizationId });
  const unknownRoles = [...organization.unknownRoles, ...application.unknownRoles];
  if (unknownRoles.length) log.warn("auth.roles.unknown", { unknownRoles });
  log.info("auth.context.resolved", { organizationRoles: organizationAssignments, applicationRoles: applicationAssignments });
  const access = new AccessEvaluator(permissions, {
    principal: { type: "user", id: session.user.id },
    tenant: { organizationId },
    authority: { organization: organization.permissions, application: application.permissions },
    assignments: { organization: organizationAssignments, application: applicationAssignments },
    entitlements: { get: (code) => { const decision = entitlements.resolve(code); return { code, enabled: decision.enabled, source: decision.source, ...(decision.inheritedFrom ? { inheritedFrom: decision.inheritedFrom } : {}) }; } },
  });
  return {
    principal: { id: session.user.id, kind: "user", email: session.user.email },
    tenant: { organizationId, role: membership.role },
    permissions: new Set([...organization.permissions.keys(), ...application.permissions.keys()]),
    assignments: { organization: organizationAssignments, application: applicationAssignments },
    entitlements,
    access,
    correlation,
    data: createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId),
    events: createEventPublisher({ organizationId, correlationId: correlation.correlationId, clock }),
    log,
    metrics: createMetrics(log),
    clock,
    features: { enabled: (name) => entitlements.has(name) },
    services: createServices(environment),
  };
}

export const requireExecutionContext = createMiddleware<{ Bindings: AuthEnvironment; Variables: AppVariables }>(async (context, next) => {
  try {
    const execution = await resolveExecutionContext(context.req.raw.headers, context.env, defaults, context.get("correlationId"));
    context.header("x-correlation-id", execution.correlation.correlationId);
    // Enforce the route's declared policy (packages/authz/src/routes.ts) before the handler runs.
    const method = context.req.method as HttpMethod;
    const policy = policyFor(method, context.req.path) ?? defaultResourcePolicy(method, context.req.path);
    // API keys act only through routes whose declared permission admits them.
    if (execution.principal.kind === "service_account" && !policy.permission) execution.access.require({ rejectApiKeys: true });
    if (policy.permission || policy.entitlement) execution.access.require({ ...(policy.permission ? { permission: policy.permission } : {}), ...(policy.entitlement ? { entitlement: policy.entitlement } : {}) });
    context.set("execution", execution);
    await next();
  } catch (error) {
    if (error instanceof ExecutionContextError) return context.json({ error: error.code, message: error.message }, error.status);
    if (error instanceof AccessDeniedError) return context.json(publicDenial(error.decision), error.status);
    throw error;
  }
});
