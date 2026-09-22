import { createAuth, type AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createLogger, type ExecutionContext } from "@__TRESTLE_PROJECT_NAME__/context";
import { createDatabase, createTenantDatabase, member } from "@__TRESTLE_PROJECT_NAME__/db";
import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

type AuthenticatedSession = {
  user: { id: string; email: string };
  session: { activeOrganizationId?: string | null };
};

type Membership = { role: string };

export type AppExecutionContext = ExecutionContext<
  ReturnType<typeof createTenantDatabase>,
  Record<string, never>
>;

export type AppVariables = { execution: AppExecutionContext };

export class ExecutionContextError extends Error {
  constructor(readonly code: "unauthorized" | "tenant_required" | "not_found", message: string, readonly status: 401 | 400 | 404) {
    super(message);
    this.name = "ExecutionContextError";
  }
}

type ContextDependencies = {
  getSession: (headers: Headers, environment: AuthEnvironment) => Promise<AuthenticatedSession | null>;
  findMembership: (userId: string, organizationId: string, environment: AuthEnvironment) => Promise<Membership | null>;
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
};

function permissionsFor(role: string): ReadonlySet<string> {
  const permissions = new Set(["resource:read", "resource:write"]);
  if (role === "owner" || role === "admin") permissions.add("organization:manage");
  return permissions;
}

function correlationId(headers: Headers): string {
  const supplied = headers.get("x-correlation-id");
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/u.test(supplied) ? supplied : crypto.randomUUID();
}

export async function resolveExecutionContext(
  headers: Headers,
  environment: AuthEnvironment,
  dependencies: ContextDependencies = defaults,
): Promise<AppExecutionContext> {
  const session = await dependencies.getSession(headers, environment);
  if (!session) throw new ExecutionContextError("unauthorized", "Authentication is required", 401);
  const organizationId = headers.get("x-trestle-tenant") ?? session.session.activeOrganizationId;
  if (!organizationId) throw new ExecutionContextError("tenant_required", "An organization must be selected", 400);
  const membership = await dependencies.findMembership(session.user.id, organizationId, environment);
  if (!membership) throw new ExecutionContextError("not_found", "Organization not found", 404);
  const correlation = { correlationId: correlationId(headers) };
  const log = createLogger({ correlationId: correlation.correlationId, userId: session.user.id, organizationId });
  log.info("auth.context.resolved", { role: membership.role });
  return {
    principal: { id: session.user.id, kind: "user", email: session.user.email },
    tenant: { organizationId, role: membership.role },
    permissions: permissionsFor(membership.role),
    correlation,
    data: createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId),
    log,
    clock: { now: () => new Date() },
    features: { enabled: () => false },
    services: {},
  };
}

export const requireExecutionContext = createMiddleware<{ Bindings: AuthEnvironment; Variables: AppVariables }>(async (context, next) => {
  try {
    const execution = await resolveExecutionContext(context.req.raw.headers, context.env);
    context.set("execution", execution);
    context.header("x-correlation-id", execution.correlation.correlationId);
    await next();
  } catch (error) {
    if (error instanceof ExecutionContextError) return context.json({ error: error.code, message: error.message }, error.status);
    throw error;
  }
});
