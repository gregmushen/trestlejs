import { AccessEvaluator, permissions, previewSupportProfile, publicDenial, AccessDeniedError, supportProfiles, type ApplicationEnvironment } from "@__TRESTLE_PROJECT_NAME__/authz";
import { Entitlements } from "@__TRESTLE_PROJECT_NAME__/billing";
import { createLogger } from "@__TRESTLE_PROJECT_NAME__/context";
import { PostgresNotificationRepository, PostgresTenantAccessRepository, PostgresWebhookRepository } from "@__TRESTLE_PROJECT_NAME__/data";
import { endpointHealth, WebhookService, type OperationContext, type SecretCipher } from "@__TRESTLE_PROJECT_NAME__/domain";
import { PlatformRequestError, type PlatformAuthority, type PlatformRepository, type SupportSessionRecord } from "@__TRESTLE_PROJECT_NAME__/platform";
import type { Context, Hono } from "hono";
import { z } from "zod";

import { supportRoutePolicies } from "./route-policies.js";

type SupportState = { session: SupportSessionRecord; access: AccessEvaluator; operation: OperationContext };
type Environment = {
  Bindings: { DATABASE_URL: string; DATABASE_DRIVER?: "neon-http" | "postgres-js"; APP_ENV?: ApplicationEnvironment };
  Variables: { authority: PlatformAuthority; correlationId: string; support: SupportState };
};

export type SupportDependencies = Readonly<{
  repository: (environment: Environment["Bindings"]) => PlatformRepository;
  now: () => Date;
  audit: (context: Context<Environment>, entry: Readonly<{ name: string; organizationId: string | null; targetType: string; targetId: string; reason: string; summary: Record<string, unknown> }>) => Parameters<PlatformRepository["mutate"]>[1];
}>;

/** Support actions never use signing secrets; the customer Worker signs and sends queued deliveries. */
const noSecrets: SecretCipher = {
  encrypt: async () => { throw new PlatformRequestError(403, "secret_access_denied", "Support sessions cannot create or reveal signing secrets"); },
  decrypt: async () => { throw new PlatformRequestError(403, "secret_access_denied", "Support sessions cannot use signing secrets"); },
};

const durations = [15, 30, 60, 120, 240] as const;

const compiledSupportPolicies = supportRoutePolicies.map((policy) => ({
  policy,
  pattern: new RegExp(`^${policy.path.split("/").map((segment) => segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("/")}$`, "u"),
}));

/**
 * Support sessions (docs/ADMIN_ADDITIONS_SPEC.md §3). Starting one requires
 * platform.support.enter_tenant, a reason, a duration, and an application-owned
 * support profile; the permission grants no tenant authority by itself. While
 * active, tenant work runs as the operator with the profile's frozen permission
 * snapshot, through tenant repositories and forced RLS, and every record carries
 * the session ID and reason.
 */
export function registerSupportRoutes(admin: Hono<Environment>, dependencies: SupportDependencies) {
  const environmentOf = (context: Context<Environment>): ApplicationEnvironment => context.env.APP_ENV ?? "local";

  /** Ends an expired session lazily, so authority disappears at the deadline even without a cron. */
  async function current(context: Context<Environment>) {
    const repository = dependencies.repository(context.env);
    const operator = context.get("authority").operator;
    const session = await repository.activeSupportSession(operator.id);
    if (session && Date.parse(session.expiresAt) <= dependencies.now().getTime()) {
      await repository.mutate(repository.endSupportSession(session.id, "expired", "system:support-expiry"), dependencies.audit(context, { name: "platform.support_session.expired", organizationId: session.organizationId, targetType: "support_session", targetId: session.id, reason: "session reached its expiration", summary: {} }));
      return null;
    }
    return session;
  }

  admin.get("/api/admin/support/profiles", (context) => {
    context.get("authority").require("platform.support.enter_tenant");
    return context.json({ profiles: supportProfiles.list(), durations });
  });

  admin.post("/api/admin/support/preview", async (context) => {
    context.get("authority").require("platform.support.enter_tenant");
    const input = z.object({ organizationId: z.string().min(1), profile: z.string().min(1) }).parse(await context.req.json().catch(() => ({})));
    const profile = supportProfiles.get(input.profile);
    if (!profile) throw new PlatformRequestError(422, "invalid", `${input.profile} is not a support profile`);
    const repository = dependencies.repository(context.env);
    if (!(await repository.organization(input.organizationId))) throw new PlatformRequestError(404, "not_found", "Organization not found");
    return context.json({ profile, permissions: previewSupportProfile(permissions, profile, new Entitlements(await repository.effectiveEntitlements(input.organizationId))) });
  });

  admin.post("/api/admin/support/sessions", async (context) => {
    const input = z.object({ organizationId: z.string().min(1), profile: z.string().min(1), reason: z.string(), ticket: z.string().trim().max(120).optional(), durationMinutes: z.number().int() }).parse(await context.req.json().catch(() => ({})));
    const authority = context.get("authority");
    const reason = authority.requireSensitive("platform.support.enter_tenant", input.reason);
    if (!durations.includes(input.durationMinutes as (typeof durations)[number])) throw new PlatformRequestError(422, "invalid", `Duration must be one of ${durations.join(", ")} minutes`);
    const profile = supportProfiles.get(input.profile);
    if (!profile) throw new PlatformRequestError(422, "invalid", `${input.profile} is not a support profile`);
    const repository = dependencies.repository(context.env);
    const organization = await repository.organization(input.organizationId);
    if (!organization) throw new PlatformRequestError(404, "not_found", "Organization not found");
    const preview = previewSupportProfile(permissions, profile, new Entitlements(await repository.effectiveEntitlements(input.organizationId)));
    const snapshot = {
      organization: preview.filter((entry) => entry.plane === "organization" && entry.allowed).map((entry) => entry.code),
      application: preview.filter((entry) => entry.plane === "application" && entry.allowed).map((entry) => entry.code),
      denied: preview.filter((entry) => !entry.allowed).map((entry) => entry.code),
    };
    const previous = await current(context);
    const id = `sup_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const expiresAt = new Date(dependencies.now().getTime() + input.durationMinutes * 60_000);
    await repository.mutate(repository.startSupportSession({ id, operatorId: authority.operator.id, organizationId: input.organizationId, reason, ticket: input.ticket || null, profile: profile.key, permissions: snapshot, expiresAt }),
      dependencies.audit(context, { name: "platform.support_session.started", organizationId: input.organizationId, targetType: "support_session", targetId: id, reason, summary: { profile: profile.key, ticket: input.ticket || null, expiresAt: expiresAt.toISOString(), granted: [...snapshot.organization, ...snapshot.application], ...(previous ? { replaced: previous.id } : {}) } }));
    return context.json({ session: await repository.activeSupportSession(authority.operator.id) }, 201);
  });

  admin.delete("/api/admin/support/sessions/current", async (context) => {
    const repository = dependencies.repository(context.env);
    const session = await current(context);
    if (session) await repository.mutate(repository.endSupportSession(session.id, "exited", context.get("authority").operator.id), dependencies.audit(context, { name: "platform.support_session.exited", organizationId: session.organizationId, targetType: "support_session", targetId: session.id, reason: "operator exited", summary: {} }));
    return context.body(null, 204);
  });

  admin.get("/api/admin/support/sessions", async (context) => {
    context.get("authority").require("platform.support.read");
    const organizationId = context.req.query("organizationId");
    return context.json({ sessions: await dependencies.repository(context.env).supportSessions({ active: context.req.query("status") === "active", ...(organizationId ? { organizationId } : {}) }) });
  });

  admin.get("/api/admin/support/sessions/:id", async (context) => {
    context.get("authority").require("platform.support.read");
    const detail = await dependencies.repository(context.env).supportSessionDetail(context.req.param("id"));
    return detail ? context.json(detail) : context.json({ error: "not_found", message: "Support session not found" }, 404);
  });

  admin.post("/api/admin/support/sessions/:id/revoke", async (context) => {
    const authority = context.get("authority");
    const reason = authority.requireSensitive("platform.support.revoke", (await context.req.json().catch(() => ({})) as { reason?: unknown }).reason);
    const repository = dependencies.repository(context.env);
    const detail = await repository.supportSessionDetail(context.req.param("id"));
    if (!detail || detail.session.endedAt) throw new PlatformRequestError(409, "not_active", "Only an active support session can be revoked");
    await repository.mutate(repository.endSupportSession(detail.session.id, "revoked", authority.operator.id, reason), dependencies.audit(context, { name: "platform.support_session.revoked", organizationId: detail.session.organizationId, targetType: "support_session", targetId: detail.session.id, reason, summary: { operator: detail.session.operatorId } }));
    return context.json({ succeeded: [detail.session.id] });
  });

  // Acting in the tenant: the session must be active on every request, and the
  // route's organization or application permission must be in its snapshot.
  admin.use("/api/admin/support/tenant/*", async (context, next) => {
    const authority = context.get("authority");
    authority.require("platform.support.enter_tenant");
    const session = await current(context);
    if (!session) return context.json({ error: "support_session_required", message: "Start a support session to act in a tenant" }, 403);
    const repository = dependencies.repository(context.env);
    const entitlements = new Entitlements(await repository.effectiveEntitlements(session.organizationId));
    const grant = (codes: readonly string[]) => new Map(codes.map((code) => [code, [`support:${session.profile}`]] as const));
    const access = new AccessEvaluator(permissions, {
      principal: { type: "user", id: authority.operator.id, label: `${authority.operator.email} (support)` },
      tenant: { organizationId: session.organizationId, label: session.organizationName },
      authority: { organization: grant(session.permissions.organization), application: grant(session.permissions.application) },
      assignments: { organization: [`support:${session.profile}`], application: [`support:${session.profile}`] },
      entitlements,
    });
    const matched = compiledSupportPolicies.find(({ policy, pattern }) => policy.method === context.req.method && pattern.test(context.req.path))?.policy;
    // The workspace summary itself needs only the active session; every other route needs its permission.
    const summary = context.req.method === "GET" && context.req.path === "/api/admin/support/tenant";
    if (!matched && !summary) return context.json({ error: "not_found", message: "Unknown support route" }, 404);
    if (matched?.revealsSecret) return context.json({ error: "secret_access_denied", message: "Secret access is never available in a support session" }, 403);
    try { if (matched?.permission) access.require({ permission: matched.permission }); } catch (error) {
      if (error instanceof AccessDeniedError) return context.json(publicDenial(error.decision), 403);
      throw error;
    }
    const operation: OperationContext = { organizationId: session.organizationId, actor: { type: "platform_operator", id: authority.operator.id }, correlationId: context.get("correlationId"), environment: environmentOf(context), now: dependencies.now(), support: { sessionId: session.id, reason: session.reason } };
    context.set("support", { session, access, operation });
    createLogger({ correlationId: operation.correlationId, operatorId: authority.operator.id, organizationId: session.organizationId, supportSessionId: session.id }).info("platform.support.request", { method: context.req.method, route: matched?.path ?? context.req.path });
    await next();
  });

  const tenant = (context: Context<Environment>) => context.get("support").session.organizationId;
  const webhooks = (context: Context<Environment>) => new PostgresWebhookRepository(context.env.DATABASE_URL, context.env.DATABASE_DRIVER, tenant(context));

  admin.get("/api/admin/support/tenant", (context) => {
    const { session, access } = context.get("support");
    return context.json({ session, permitted: access.permitted() });
  });

  admin.get("/api/admin/support/tenant/members", async (context) => {
    const members = await new PostgresTenantAccessRepository(context.env.DATABASE_URL, context.env.DATABASE_DRIVER, tenant(context)).listMembers();
    return context.json({ members: members.map(({ memberId, userId, name, organizationRoles }) => ({ memberId, userId, name, organizationRoles })) });
  });

  admin.get("/api/admin/support/tenant/webhooks", async (context) => {
    const endpoints = await webhooks(context).listEndpoints();
    return context.json({ endpoints: endpoints.map((endpoint) => ({ id: endpoint.id, name: endpoint.name, url: endpoint.urlDisplay, events: endpoint.events, state: endpoint.state, health: endpointHealth(endpoint), consecutiveFailures: endpoint.consecutiveFailures, lastSuccessAt: endpoint.lastSuccessAt?.toISOString() ?? null, lastFailureAt: endpoint.lastFailureAt?.toISOString() ?? null })) });
  });

  admin.get("/api/admin/support/tenant/webhooks/:id", async (context) => {
    const deliveries = await webhooks(context).listDeliveries(context.req.param("id"), 50);
    return context.json({ deliveries: deliveries.map((delivery) => ({ id: delivery.id, event: delivery.eventName, status: delivery.status, attempts: delivery.attempts, responseCode: delivery.lastResponseCode, failureCategory: delivery.failureCategory, test: delivery.test, createdAt: delivery.createdAt.toISOString() })) });
  });

  for (const [action, state] of [["pause", "paused"], ["resume", "active"]] as const) {
    admin.post(`/api/admin/support/tenant/webhooks/:id/${action}`, async (context) => {
      await new WebhookService(webhooks(context), noSecrets).setState(context.get("support").operation, context.req.param("id"), state);
      return context.json({ succeeded: [context.req.param("id")] });
    });
  }

  /** Queues a marked test delivery; the customer Worker signs and sends it on its next run. */
  admin.post("/api/admin/support/tenant/webhooks/:id/test", async (context) => {
    const deliveryId = await new WebhookService(webhooks(context), noSecrets).sendTest(context.get("support").operation, context.req.param("id"));
    return context.json({ succeeded: [deliveryId] }, 201);
  });

  admin.post("/api/admin/support/tenant/webhook-deliveries/:id/replay", async (context) => {
    const replayId = await new WebhookService(webhooks(context), noSecrets).replay(context.get("support").operation, context.req.param("id"));
    return context.json({ succeeded: [replayId] }, 201);
  });

  admin.get("/api/admin/support/tenant/notification-deliveries", async (context) => {
    const deliveries = await new PostgresNotificationRepository(context.env.DATABASE_URL, context.env.DATABASE_DRIVER, tenant(context)).deliveries({ limit: 100 });
    return context.json({ deliveries: deliveries.map((delivery) => ({ id: delivery.id, type: delivery.type, channel: delivery.channel, status: delivery.status, preference: delivery.preferenceSource, failureCategory: delivery.failureCategory, createdAt: delivery.createdAt.toISOString() })) });
  });

  admin.get("/api/admin/support/tenant/audit", async (context) => {
    const events = await new PostgresTenantAccessRepository(context.env.DATABASE_URL, context.env.DATABASE_DRIVER, tenant(context)).listAudit(100);
    return context.json({ events: events.map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString() })) });
  });
}
