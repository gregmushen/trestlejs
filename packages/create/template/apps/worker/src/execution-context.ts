import { createAuth, type AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createAccessController, createLogger, createMetrics, type EntitlementDecision, type Entitlements, type ExecutionContext } from "@__TRESTLE_PROJECT_NAME__/context";
import { createDatabase, createTenantDatabase, member } from "@__TRESTLE_PROJECT_NAME__/db";
import type { SubscriptionSummary } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { createEventPublisher, type EventPublisher } from "./events.js";
import { createServices, type AppServices } from "./services.js";

type AuthenticatedSession = {
  user: { id: string; email: string };
  session: { activeOrganizationId?: string | null };
};

type Membership = { role: string; applicationRole: string | null };

export type AppExecutionContext = ExecutionContext<
  ReturnType<typeof createTenantDatabase>,
  AppServices
> & Readonly<{ events: EventPublisher }>;

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
  findSubscription: (organizationId: string, environment: AuthEnvironment) => Promise<SubscriptionSummary | null>;
};

const defaults: ContextDependencies = {
  getSession: async (headers, environment) => await createAuth(environment).api.getSession({ headers }) as AuthenticatedSession | null,
  findMembership: async (userId, organizationId, environment) => {
    const [record] = await createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER)
      .select({ role: member.role, applicationRole: member.applicationRole })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
      .limit(1);
    return record ?? null;
  },
  findSubscription: async (organizationId, environment) => await createServices(environment).billing.getSubscription(organizationId),
};

function organizationPermissions(role: string): ReadonlySet<string> {
  return role === "owner" || role === "admin"
    ? new Set(["organization:manage", "organization:webhooks:read", "organization:webhooks:manage", "organization:webhooks:deliveries:read"])
    : new Set();
}

function applicationPermissions(role: string | null): ReadonlySet<string> | undefined {
  if (role === "contributor") return new Set(["resource:read", "resource:write"]);
  if (role === "viewer") return new Set(["resource:read"]);
  return undefined;
}

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
  const subscription = await dependencies.findSubscription(organizationId, environment);
  const decisions = new Map((subscription?.effectiveEntitlements ?? subscription?.entitlements.map((code) => ({ code, enabled: true, source: "plan" as const, inheritedFrom: `${subscription.plan}@${subscription.planVersion}`, effectiveAt: new Date() })) ?? []).map((decision) => [decision.code, decision]));
  const entitlements: Entitlements = {
    resolve: (code): EntitlementDecision => decisions.get(code) ?? { code, enabled: false, source: "default", effectiveAt: new Date(0) },
    has: (code) => decisions.get(code)?.enabled ?? false,
  };
  const appPermissions = applicationPermissions(membership.applicationRole);
  const authority = { planes: {
    organization: organizationPermissions(membership.role),
    ...(appPermissions ? { application: appPermissions } : {}),
  } };
  const correlation = { correlationId: suppliedCorrelationId ?? correlationId(headers) };
  const clock = { now: () => new Date() };
  const log = createLogger({ correlationId: correlation.correlationId, userId: session.user.id, organizationId });
  log.info("auth.context.resolved", { organizationRole: membership.role, applicationRole: membership.applicationRole });
  return {
    principal: { id: session.user.id, kind: "user", email: session.user.email },
    tenant: { organizationId, role: membership.role },
    authority,
    entitlements,
    access: createAccessController(authority, entitlements),
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
    context.set("execution", execution);
    context.header("x-correlation-id", execution.correlation.correlationId);
    await next();
  } catch (error) {
    if (error instanceof ExecutionContextError) return context.json({ error: error.code, message: error.message }, error.status);
    throw error;
  }
});
