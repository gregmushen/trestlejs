import { createAuth, type AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { AccessDeniedError, platformAccess, publicDenial, type AccessEvaluator } from "@__TRESTLE_PROJECT_NAME__/authz";
import { createLogger } from "@__TRESTLE_PROJECT_NAME__/context";
import {
  artifactOperations, createPlatformDatabase, disableWebhookEndpoint, listDeadOutboxEvents, listFailedWebhookDeliveries, listPlatformWebhookEndpoints,
  PlatformOperationError, redriveOutboxEvent, replayWebhookDelivery, type DatabaseDriver, type PlatformChangeContext,
} from "@__TRESTLE_PROJECT_NAME__/db";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";

import { adminViews, type AdminCapability } from "../src/registry.js";
import { databaseReachable, overview, platformRolesFor } from "./data.js";
import { adminPolicyFor } from "./route-policies.js";

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
  APP_ENV?: "local" | "preview" | "staging" | "production";
};

type Session = { user: { id: string; email: string; name?: string } };
type Variables = { correlationId: string; operator: Session["user"]; access: AccessEvaluator; roles: string[] };

/** Replaceable in tests. */
export const adminDependencies = {
  session: async (environment: AdminEnvironment, headers: Headers): Promise<Session | null> => await adminAuth(environment).api.getSession({ headers }) as Session | null,
  platformRoles: async (environment: AdminEnvironment, userId: string): Promise<string[]> => await platformRolesFor(platformDatabase(environment), userId),
  operationalStatus: async (environment: AdminEnvironment): Promise<unknown> => {
    const response = await fetch(new URL("/api/health/operational", environment.API_URL ?? "http://127.0.0.1:8787"), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`status ${response.status}`);
    return await response.json();
  },
};

function adminAuth(environment: AdminEnvironment) {
  // The same accounts sign in on a separate origin with separate cookies; customer sessions never reach the admin.
  return createAuth({ ...environment, BETTER_AUTH_URL: environment.ADMIN_API_URL ?? "http://localhost:8788", WEB_ORIGIN: environment.ADMIN_ORIGIN ?? "http://localhost:42070", EMAIL_DELIVERY_MODE: "local" } as AuthEnvironment);
}

function platformConnection(environment: AdminEnvironment): string {
  if (environment.DATABASE_ADMIN_URL) return environment.DATABASE_ADMIN_URL;
  if ((environment.APP_ENV ?? "local") === "local") return environment.DATABASE_URL;
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

// Only sign-in, session, and sign-out are exposed; sign-up and organization endpoints do not exist here.
for (const [method, path] of [["POST", "/api/auth/sign-in/email"], ["POST", "/api/auth/sign-out"], ["GET", "/api/auth/get-session"]] as const) {
  admin.on(method, path, async (context) => await adminAuth(context.env).handler(context.req.raw));
}

/** Platform authentication and authority for every admin API route. */
admin.use("/api/admin/*", async (context, next) => {
  const policy = adminPolicyFor(context.req.method, context.req.path);
  if (policy?.public) return await next();
  const log = createLogger({ correlationId: context.get("correlationId"), surface: "admin" });
  try {
    const session = await adminDependencies.session(context.env, context.req.raw.headers);
    if (!session) return context.json({ error: "unauthorized", message: "Sign in to the platform admin" }, 401);
    const roles = await adminDependencies.platformRoles(context.env, session.user.id);
    const { access, unknownRoles } = platformAccess(session.user.id, roles);
    if (unknownRoles.length) log.warn("admin.roles.unknown", { unknownRoles });
    // Tenant membership or ownership never grants platform access.
    if (roles.length === 0) return context.json({ error: "forbidden", reason: "no_platform_roles", message: "This account has no platform role" }, 403);
    if (!policy) return context.json({ error: "not_found" }, 404);
    if (policy.permission) access.require({ permission: policy.permission });
    context.set("operator", session.user);
    context.set("access", access);
    context.set("roles", roles);
    await next();
  } catch (error) {
    if (error instanceof AccessDeniedError) return context.json(publicDenial(error.decision), error.status);
    if (error instanceof AdminConfigurationError) return context.json({ error: "not_configured", message: error.message, repair: `pnpm exec trestle setup --env ${context.env.APP_ENV ?? "local"}` }, 503);
    throw error;
  }
});

admin.get("/api/admin/session", (context) => {
  const access = context.get("access");
  return context.json({
    operator: { id: context.get("operator").id, email: context.get("operator").email },
    roles: context.get("roles"),
    permissions: access.permitted(),
    views: adminViews.map((view) => ({ id: view.id, path: view.path, label: view.label, group: view.group, capability: view.capability ?? null, allowed: access.check({ permission: view.permission }) })),
  });
});

admin.get("/api/admin/overview", async (context) => context.json(await overview(platformDatabase(context.env))));

type AdminContext = Context<{ Bindings: AdminEnvironment; Variables: Variables }>;

/** Every platform action names its operator, reason, environment, and correlation ID for audit_event. */
async function actionContext(context: AdminContext): Promise<PlatformChangeContext> {
  const body = await context.req.json().catch(() => ({})) as { reason?: unknown };
  if (typeof body.reason !== "string") throw new PlatformOperationError("invalid", "A reason is required");
  return { actor: { type: "platform_operator", id: context.get("operator").id }, reason: body.reason, environment: context.env.APP_ENV ?? "local", correlationId: context.get("correlationId") };
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

admin.get("/api/admin/operations/outbox", async (context) => {
  const events = await listDeadOutboxEvents(platformDatabase(context.env), { limit: Number(context.req.query("limit") ?? 50) });
  return context.json({ dead: events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })) });
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
  await replayWebhookDelivery(platformDatabase(context.env), { organizationId: context.req.param("organizationId"), deliveryId: context.req.param("deliveryId") }, await actionContext(context));
  return context.json({ replayed: true, correlationId: context.get("correlationId") });
});

admin.get("/api/admin/operations/artifacts", async (context) => {
  // Pending uploads older than a day are stale; the artifact maintenance job cleans them up.
  return context.json(await artifactOperations(platformDatabase(context.env), { staleBefore: new Date(Date.now() - 86_400_000) }));
});

const capabilityLabels: Record<AdminCapability, string> = { database: "Database", email: "Email", billing: "Billing", queues: "Queues", artifacts: "Artifacts", workflows: "Workflows" };

/** Sanitized: configured flags and modes only, never values. Unconfigured capabilities carry a setup command. */
export function capabilityGuidance(status: unknown, environment: string) {
  const reported = (status && typeof status === "object" ? (status as { capabilities?: Record<string, { configured?: unknown; mode?: unknown; enabled?: unknown }> }).capabilities : undefined) ?? {};
  const repair = `pnpm exec trestle setup --env ${environment}`;
  return (Object.keys(capabilityLabels) as AdminCapability[]).map((id) => {
    const entry = reported[id];
    if (!entry) return { id, label: capabilityLabels[id], state: "unknown" as const, repair };
    const configured = entry.configured === true;
    const mode = typeof entry.mode === "string" && /^[a-z0-9-]{1,32}$/u.test(entry.mode) ? entry.mode : undefined;
    return { id, label: capabilityLabels[id], state: configured ? "configured" as const : "not_configured" as const, ...(mode ? { mode } : {}), ...(configured ? {} : { repair }) };
  });
}

admin.get("/api/admin/health", async (context) => {
  const environment = context.env.APP_ENV ?? "local";
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

const operationStatus = { invalid: 400, not_found: 404, conflict: 409 } as const;

admin.onError((error, context) => {
  if (error instanceof PlatformOperationError) return context.json({ error: error.code, message: error.message, correlationId: context.get("correlationId") }, operationStatus[error.code]);
  createLogger({ correlationId: context.get("correlationId"), surface: "admin" }).error("admin.request.failed", { errorName: error.name });
  return context.json({ error: "internal_error", message: "The request could not be completed" }, 500);
});

export default { fetch: admin.fetch.bind(admin) };
