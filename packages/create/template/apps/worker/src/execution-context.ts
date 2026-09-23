import { loadAuthPolicy, type AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import {
  AccessDeniedError,
  AccessEvaluator,
  acceptsApiKeys,
  apiKeyStatus,
  bearerApiKey,
  parseApiKey,
  parseMembershipRoles,
  publicDenial,
  verifyApiKey,
  type AccessCatalog,
  type ApplicationEnvironment,
  type CredentialStatus,
  type CustomRoleInput,
  type HttpMethod,
} from "@__TRESTLE_PROJECT_NAME__/authz";
import { Entitlements, evaluateQuota, features, periodBounds, type EffectiveEntitlement } from "@__TRESTLE_PROJECT_NAME__/billing";
import { createLogger, createMetrics, type ExecutionContext } from "@__TRESTLE_PROJECT_NAME__/context";
import { loadAccessCatalog } from "@__TRESTLE_PROJECT_NAME__/data";
import { applicationConnectionString, createSqlRunner, createTenantDatabase } from "@__TRESTLE_PROJECT_NAME__/db";
import { codeAccessCatalog } from "@__TRESTLE_PROJECT_NAME__/domain";
import { createMiddleware } from "hono/factory";

import { workerAuth } from "./auth.js";
import { defaultAccessDependencies, type ResolvedApiKey } from "./access-dependencies.js";
import { notificationService } from "./communications.js";
import { createEventPublisher } from "./events.js";
import { defaultResourcePolicy, policyFor } from "./route-policies.js";
import { createServices, type AppServices } from "./services.js";

type AuthenticatedSession = {
  user: { id: string; email: string };
  session: { activeOrganizationId?: string | null };
};

export type AppExecutionContext = ExecutionContext<
  ReturnType<typeof createTenantDatabase>,
  AppServices,
  AccessEvaluator,
  Entitlements
> & {
  /** Reviewed permissions and built-in roles plus the admin's runtime catalog, as loaded for this request. */
  accessCatalog: AccessCatalog;
  /**
   * Sends a notification by type: a code definition or a published stream.
   * The resolved stream version is recorded; unknown or archived types throw.
   */
  notifications: { send(input: NotificationSendInput): Promise<{ created: number; streamVersion: number | null }> };
};

export type NotificationSendInput = Readonly<{ type: string; recipient: Readonly<{ userId: string } | { userIds: readonly string[] } | { organizationRole: string }>; data: Record<string, unknown> }>;

function notificationSender(environment: AuthEnvironment, organizationId: string, actor: { type: "user" | "service_account"; id: string }, correlationId: string, now: () => Date) {
  return {
    send: async (input: NotificationSendInput) => await (await notificationService(environment, organizationId)).send(
      { organizationId, actor, correlationId, environment: environment.APP_ENV ?? "local", now: now() }, { ...input, data: input.data as never }),
  };
}

export type AppVariables = { execution: AppExecutionContext; correlationId: string; requestStartedAt: number };

export class ExecutionContextError extends Error {
  constructor(readonly code: "unauthorized" | "tenant_required" | "not_found" | "rate_limited" | "quota_exceeded", message: string, readonly status: 401 | 400 | 404 | 429) {
    super(message);
    this.name = "ExecutionContextError";
  }
}

export type ContextDependencies = {
  getSession: (headers: Headers, environment: AuthEnvironment) => Promise<AuthenticatedSession | null>;
  findMembership: (userId: string, organizationId: string, environment: AuthEnvironment) => Promise<{ role: string } | null>;
  /** Tenant-scoped application-role assignments, stored separately from organization membership roles. */
  loadApplicationRoles: (userId: string, organizationId: string, environment: AuthEnvironment) => Promise<string[]>;
  loadCustomRoles: (organizationId: string, environment: AuthEnvironment) => Promise<CustomRoleInput[]>;
  loadEntitlements: (organizationId: string, environment: AuthEnvironment) => Promise<EffectiveEntitlement[]>;
  resolveApiKey: (publicId: string, environment: AuthEnvironment) => Promise<ResolvedApiKey | null>;
  meteredUsage: (organizationId: string, code: string, periodStart: Date, environment: AuthEnvironment) => Promise<number>;
  recordApiKeyUse: (key: ResolvedApiKey, outcome: "allowed" | "denied", environment: AuthEnvironment, metered?: { code: string; period: { start: Date; end: Date } }) => Promise<void>;
  now: () => Date;
  /** The runtime access catalog; omitted in tests that only need the reviewed registry. */
  loadAccessCatalog?: (environment: AuthEnvironment) => Promise<AccessCatalog>;
};

const defaults: ContextDependencies = {
  loadAccessCatalog: async (environment) => await loadAccessCatalog(createSqlRunner(applicationConnectionString(environment.DATABASE_URL), environment.DATABASE_DRIVER)),
  getSession: async (headers, environment) => { await loadAuthPolicy(environment); return await workerAuth(environment).api.getSession({ headers }) as AuthenticatedSession | null; },
  ...defaultAccessDependencies,
  now: () => new Date(),
};

function correlationId(headers: Headers): string {
  const supplied = headers.get("x-correlation-id");
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/u.test(supplied) ? supplied : crypto.randomUUID();
}

function applicationEnvironment(environment: AuthEnvironment): ApplicationEnvironment {
  return environment.APP_ENV ?? "local";
}

/** Metered feature consumed by every API-key request (packages/billing/src/catalog.ts). */
const apiRequestFeature = "api.requests";

/** Per-isolate fixed-window limiter for each key's configured policy. */
const windows = new Map<string, { windowStart: number; count: number }>();
function withinRateLimit(key: ResolvedApiKey, now: Date): boolean {
  if (!key.rateLimitPerMinute) return true;
  const windowStart = Math.floor(now.getTime() / 60_000);
  const current = windows.get(key.id);
  const next = current && current.windowStart === windowStart ? { windowStart, count: current.count + 1 } : { windowStart, count: 1 };
  windows.set(key.id, next);
  if (windows.size > 10_000) windows.clear();
  return next.count <= key.rateLimitPerMinute;
}

export async function resolveExecutionContext(
  headers: Headers,
  environment: AuthEnvironment,
  dependencies: ContextDependencies = defaults,
  suppliedCorrelationId?: string,
): Promise<AppExecutionContext> {
  const correlation = { correlationId: suppliedCorrelationId ?? correlationId(headers) };
  // Loaded only after authentication succeeds, so anonymous requests never reach the database.
  const loadCatalog = async (): Promise<AccessCatalog> => dependencies.loadAccessCatalog ? await dependencies.loadAccessCatalog(environment) : codeAccessCatalog;
  const appEnvironment = applicationEnvironment(environment);
  const token = bearerApiKey(headers.get("authorization"));

  if (token) {
    const parsed = parseApiKey(token);
    const key = parsed ? await dependencies.resolveApiKey(parsed.publicId, environment) : null;
    const log = createLogger({ correlationId: correlation.correlationId, apiKeyId: key?.id ?? "unknown" });
    if (!key || !(await verifyApiKey(token, key.verifier))) {
      log.warn("auth.api_key.rejected", { reason: "unknown_or_invalid" });
      throw new ExecutionContextError("unauthorized", "A valid API key is required", 401);
    }
    const status: CredentialStatus = apiKeyStatus(key, { now: dependencies.now(), environment: appEnvironment, clientIp: headers.get("cf-connecting-ip"), serviceAccountStatus: key.serviceAccountStatus });
    if (status !== "active") {
      log.warn("auth.api_key.rejected", { reason: status, organizationId: key.organizationId });
      await dependencies.recordApiKeyUse(key, "denied", environment);
      throw new ExecutionContextError("unauthorized", "A valid API key is required", 401);
    }
    const selected = headers.get("x-trestle-tenant");
    if (selected && selected !== key.organizationId) throw new ExecutionContextError("not_found", "Organization not found", 404);
    if (!withinRateLimit(key, dependencies.now())) throw new ExecutionContextError("rate_limited", "API-key rate limit exceeded", 429);
    const [catalog, customRoles, effective] = await Promise.all([loadCatalog(), dependencies.loadCustomRoles(key.organizationId, environment), dependencies.loadEntitlements(key.organizationId, environment)]);
    const entitlements = new Entitlements(effective);
    const granted = catalog.application.withCustomRoles(customRoles).resolve(key.serviceAccountRoles).permissions;
    const access = new AccessEvaluator(catalog.permissions, {
      principal: { type: "service_account", id: key.serviceAccountId },
      tenant: { organizationId: key.organizationId },
      authority: { application: granted },
      assignments: { application: [...key.serviceAccountRoles] },
      scopes: new Set(key.scopes),
      credential: { id: key.id, status },
      entitlements,
      constraints: [{ name: "Environment", expected: key.environment, actual: appEnvironment, satisfied: key.environment === appEnvironment }],
    });
    // Usage is metered separately from authorization: an authorized request can still exhaust a hard quota.
    const metered = features.get(apiRequestFeature)?.metered;
    const period = metered ? periodBounds(metered.period, dependencies.now()) : undefined;
    const allowance = entitlements.get(apiRequestFeature);
    if (period && allowance?.enabled) {
      const quota = evaluateQuota(allowance, await dependencies.meteredUsage(key.organizationId, apiRequestFeature, period.start, environment), period);
      if (!quota.allowed) {
        await dependencies.recordApiKeyUse(key, "denied", environment);
        throw new ExecutionContextError("quota_exceeded", `The ${apiRequestFeature} allowance for this period is exhausted`, 429);
      }
    }
    await dependencies.recordApiKeyUse(key, "allowed", environment, period && allowance?.enabled ? { code: apiRequestFeature, period } : undefined);
    log.info("auth.context.resolved", { principalType: "service_account", organizationId: key.organizationId });
    const keyLog = createLogger({ correlationId: correlation.correlationId, serviceAccountId: key.serviceAccountId, organizationId: key.organizationId });
    return {
      principal: { id: key.serviceAccountId, kind: "service_account", credentialId: key.id },
      tenant: { organizationId: key.organizationId },
      permissions: new Set([...granted.keys()].filter((code) => key.scopes.includes(code))),
      access,
      entitlements,
      environment: appEnvironment,
      correlation,
      data: createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, key.organizationId),
      log: keyLog,
      metrics: createMetrics(keyLog),
      clock: { now: dependencies.now },
      features: { enabled: (name) => entitlements.has(name) },
      services: createServices(environment),
      events: createEventPublisher(environment, key.organizationId, correlation.correlationId),
      accessCatalog: catalog,
      notifications: notificationSender(environment, key.organizationId, { type: "service_account", id: key.serviceAccountId }, correlation.correlationId, dependencies.now),
    };
  }

  const session = await dependencies.getSession(headers, environment);
  if (!session) throw new ExecutionContextError("unauthorized", "Authentication is required", 401);
  const organizationId = headers.get("x-trestle-tenant") ?? session.session.activeOrganizationId;
  if (!organizationId) throw new ExecutionContextError("tenant_required", "An organization must be selected", 400);
  const membership = await dependencies.findMembership(session.user.id, organizationId, environment);
  if (!membership) throw new ExecutionContextError("not_found", "Organization not found", 404);
  const log = createLogger({ correlationId: correlation.correlationId, userId: session.user.id, organizationId });
  const [catalog, applicationAssignments, customRoles, effective] = await Promise.all([
    loadCatalog(),
    dependencies.loadApplicationRoles(session.user.id, organizationId, environment),
    dependencies.loadCustomRoles(organizationId, environment),
    dependencies.loadEntitlements(organizationId, environment),
  ]);
  const entitlements = new Entitlements(effective);
  const organizationAssignments = parseMembershipRoles(membership.role);
  const organization = catalog.organization.resolve(organizationAssignments);
  const application = catalog.application.withCustomRoles(customRoles).resolve(applicationAssignments);
  const unknownRoles = [...organization.unknownRoles, ...application.unknownRoles];
  if (unknownRoles.length) log.warn("auth.roles.unknown", { unknownRoles });
  log.info("auth.context.resolved", { principalType: "user", organizationRoles: organizationAssignments, applicationRoles: applicationAssignments });
  return {
    principal: { id: session.user.id, kind: "user", email: session.user.email },
    tenant: { organizationId, role: membership.role },
    permissions: new Set([...organization.permissions.keys(), ...application.permissions.keys()]),
    access: new AccessEvaluator(catalog.permissions, {
      principal: { type: "user", id: session.user.id },
      tenant: { organizationId },
      // Platform authority is never resolved on the customer surface; it exists only in apps/admin.
      authority: { organization: organization.permissions, application: application.permissions },
      assignments: { organization: organizationAssignments, application: applicationAssignments },
      entitlements,
    }),
    entitlements,
    environment: appEnvironment,
    correlation,
    data: createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId),
    log,
    metrics: createMetrics(log),
    clock: { now: dependencies.now },
    features: { enabled: (name) => entitlements.has(name) },
    services: createServices(environment),
    events: createEventPublisher(environment, organizationId, correlation.correlationId),
    accessCatalog: catalog,
    notifications: notificationSender(environment, organizationId, { type: "user", id: session.user.id }, correlation.correlationId, dependencies.now),
  };
}

export function createExecutionContextMiddleware(dependencies: ContextDependencies = defaults) {
  return createMiddleware<{ Bindings: AuthEnvironment; Variables: AppVariables }>(async (context, next) => {
    try {
      const execution = await resolveExecutionContext(context.req.raw.headers, context.env, dependencies, context.get("correlationId"));
      context.header("x-correlation-id", execution.correlation.correlationId);
      const method = context.req.method as HttpMethod;
      const policy = policyFor(method, context.req.path) ?? defaultResourcePolicy(method, context.req.path);
      if (policy.permission || policy.entitlement) {
        execution.access.require({
          ...(policy.permission ? { permission: policy.permission } : {}),
          ...(policy.entitlement ? { entitlement: policy.entitlement } : {}),
          rejectApiKeys: !acceptsApiKeys(execution.accessCatalog.permissions, policy),
        });
      }
      context.set("execution", execution);
      await next();
    } catch (error) {
      if (error instanceof ExecutionContextError) return context.json({ error: error.code, message: error.message }, error.status);
      if (error instanceof AccessDeniedError) return context.json(publicDenial(error.decision), error.status);
      throw error;
    }
  });
}

/** Resolves the principal, tenant, access, and entitlements, then enforces the route's policy. */
export const requireExecutionContext = createExecutionContextMiddleware();
