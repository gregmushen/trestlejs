import { createAuth, type AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { AccessDeniedError, AccessEvaluator, applicationRoles, defaultResourcePolicy, organizationRoles, parseMembershipRoles, permissions, policyFor, publicDenial, type HttpMethod } from "@__TRESTLE_PROJECT_NAME__/authz";
import { createLogger, createMetrics, type EntitlementDecision, type Entitlements, type ExecutionContext } from "@__TRESTLE_PROJECT_NAME__/context";
import { activeApplicationRoles, createDatabase, createTenantDatabase, member } from "@__TRESTLE_PROJECT_NAME__/db";
import type { SubscriptionSummary } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
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
> & {
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
};

function correlationId(headers: Headers): string {
  const supplied = headers.get("x-correlation-id");
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/u.test(supplied) ? supplied : crypto.randomUUID();
}

export async function resolveExecutionContext(
  headers: Headers,
  environment: AuthEnvironment,
  dependencies: ContextDependencies = defaults,
  suppliedCorrelationId?: string,
): Promise<AppExecutionContext> {
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
  const decisions = new Map((subscription?.effectiveEntitlements ?? subscription?.entitlements.map((code) => ({ code, enabled: true, source: "plan" as const, inheritedFrom: `${subscription.plan}@${subscription.planVersion}`, effectiveAt: new Date() })) ?? []).map((decision) => [decision.code, decision]));
  const entitlements: Entitlements = {
    resolve: (code): EntitlementDecision => decisions.get(code) ?? { code, enabled: false, source: "default", effectiveAt: new Date(0) },
    has: (code) => decisions.get(code)?.enabled ?? false,
  };
  // Each plane resolves only from its own assignments; nothing flows between them.
  const organizationAssignments = parseMembershipRoles(membership.role);
  const organization = organizationRoles.resolve(organizationAssignments);
  const application = applicationRoles.resolve(applicationAssignments);
  const correlation = { correlationId: suppliedCorrelationId ?? correlationId(headers) };
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
    log,
    metrics: createMetrics(log),
    clock: { now: () => new Date() },
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
    if (policy.permission || policy.entitlement) execution.access.require({ ...(policy.permission ? { permission: policy.permission } : {}), ...(policy.entitlement ? { entitlement: policy.entitlement } : {}) });
    context.set("execution", execution);
    await next();
  } catch (error) {
    if (error instanceof ExecutionContextError) return context.json({ error: error.code, message: error.message }, error.status);
    if (error instanceof AccessDeniedError) return context.json(publicDenial(error.decision), error.status);
    throw error;
  }
});
