import type { ApplicationEnvironment } from "@__TRESTLE_PROJECT_NAME__/authz";
import { PostgresWebhookRepository } from "@__TRESTLE_PROJECT_NAME__/data";
import { endpointHealth, secretCipher, WebhookDomainError, WebhookService, webhookKeyMaterial, type OperationContext, type WebhookEndpoint } from "@__TRESTLE_PROJECT_NAME__/domain";
import { PlatformRequestError, type PostgresPlatformRepository } from "@__TRESTLE_PROJECT_NAME__/platform";
import type { Context, Hono } from "hono";
import { z } from "zod";

/**
 * Integrations -> Webhooks for operators (docs/ADMIN_REQUIRED_CHANGES.md §7.1).
 * Endpoints are the resource and deliveries their history. Every change runs
 * through the tenant's own WebhookService on its forced-RLS connection, so it
 * commits with tenant audit and outbox; the operator is the attributed actor
 * and their reason is recorded. Only newly generated secrets are returned,
 * exactly once.
 */

type Bindings = { DATABASE_URL: string; DATABASE_DRIVER?: "neon-http" | "postgres-js"; APP_ENV?: ApplicationEnvironment; WEBHOOK_SECRET_KEY?: string; BETTER_AUTH_SECRET: string };
type Authority = { operator: { id: string }; require(permission: string): void; requireSensitive(permission: string, reason: unknown): string };
type Environment = { Bindings: Bindings; Variables: { authority: Authority; correlationId: string } };
type Dependencies = { repository: (environment: Bindings) => PostgresPlatformRepository; now: () => Date };

const reason = z.string().trim().min(1).max(500);
const endpointInput = z.object({ name: z.string().trim().min(1).max(80), url: z.string().trim().min(1).max(2_000), events: z.array(z.string()).min(1).max(50), description: z.string().trim().max(500).nullable().optional(), timeoutMs: z.number().int().min(1_000).max(30_000).optional() });

async function json<T extends z.ZodType>(context: Context<Environment>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => undefined));
  if (!parsed.success) throw new PlatformRequestError(422, "invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  return parsed.data;
}

async function tenant<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof WebhookDomainError) throw new PlatformRequestError(error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 422, error.code, error.message);
    throw error;
  }
}

const serialize = (endpoint: WebhookEndpoint) => ({
  id: endpoint.id, name: endpoint.name, description: endpoint.description ?? null, urlDisplay: endpoint.urlDisplay, events: endpoint.events, state: endpoint.state, health: endpointHealth(endpoint),
  timeoutMs: endpoint.timeoutMs ?? 10_000, disabledReason: endpoint.disabledReason, consecutiveFailures: endpoint.consecutiveFailures,
  secret: { fingerprint: endpoint.secretFingerprint, createdAt: endpoint.secretCreatedAt.toISOString(), previousExpiresAt: endpoint.previousSecretExpiresAt?.toISOString() ?? null },
  lastSuccessAt: endpoint.lastSuccessAt?.toISOString() ?? null, lastFailureAt: endpoint.lastFailureAt?.toISOString() ?? null, verifiedAt: endpoint.verifiedAt?.toISOString() ?? null, createdAt: endpoint.createdAt.toISOString(),
});

export function registerWebhookManagementRoutes(admin: Hono<Environment>, dependencies: Dependencies) {
  const operation = (context: Context<Environment>, organizationId: string, why: string): OperationContext => ({
    organizationId, actor: { type: "platform_operator", id: context.get("authority").operator.id }, correlationId: context.get("correlationId"), environment: context.env.APP_ENV ?? "local", now: dependencies.now(), reason: why,
  });
  const service = async (context: Context<Environment>, organizationId: string) => ({
    repository: new PostgresWebhookRepository(context.env.DATABASE_URL, context.env.DATABASE_DRIVER, organizationId),
    webhooks: new WebhookService(new PostgresWebhookRepository(context.env.DATABASE_URL, context.env.DATABASE_DRIVER, organizationId), await secretCipher(webhookKeyMaterial(context.env))),
  });
  /** Which organization owns an endpoint, from the platform read model. */
  const owner = async (context: Context<Environment>, id: string) => {
    const [endpoint] = await dependencies.repository(context.env).webhookEndpoints({ id });
    if (!endpoint) throw new PlatformRequestError(404, "not_found", "Webhook endpoint not found");
    return endpoint.organizationId;
  };

  admin.get("/api/admin/webhook-event-types", async (context) => {
    context.get("authority").require("platform.webhooks.read");
    const { webhooks } = await service(context, "catalog");
    return context.json({ eventTypes: webhooks.eventTypes() });
  });

  admin.get("/api/admin/webhooks/:id", async (context) => {
    context.get("authority").require("platform.webhooks.read");
    const organizationId = await owner(context, context.req.param("id"));
    const { repository } = await service(context, organizationId);
    const endpoint = await repository.getEndpoint(context.req.param("id"));
    if (!endpoint) throw new PlatformRequestError(404, "not_found", "Webhook endpoint not found");
    const deliveries = await repository.listDeliveries(endpoint.id, 50);
    const attempts = await Promise.all(deliveries.slice(0, 20).map(async (delivery) => ({ deliveryId: delivery.id, attempts: (await repository.listAttempts(delivery.id)).map((attempt) => ({ ...attempt, attemptedAt: attempt.attemptedAt.toISOString() })) })));
    return context.json({
      endpoint: { ...serialize(endpoint), organizationId, deletedAt: endpoint.deletedAt?.toISOString() ?? null },
      deliveries: deliveries.map((delivery) => ({ ...delivery, nextAttemptAt: delivery.status === "pending" ? delivery.nextAttemptAt.toISOString() : null, createdAt: delivery.createdAt.toISOString(), completedAt: delivery.completedAt?.toISOString() ?? null })),
      attempts: Object.fromEntries(attempts.map((entry) => [entry.deliveryId, entry.attempts])),
    });
  });

  admin.post("/api/admin/webhooks", async (context) => {
    const input = await json(context, endpointInput.extend({ organizationId: z.string().min(1), reason }).strict());
    const why = context.get("authority").requireSensitive("platform.webhooks.manage", input.reason);
    const { webhooks } = await service(context, input.organizationId);
    const created = await tenant(() => webhooks.create(operation(context, input.organizationId, why), input));
    context.header("cache-control", "no-store");
    return context.json({ endpoint: serialize(created.endpoint), secret: created.secret }, 201);
  });

  admin.patch("/api/admin/webhooks/:id", async (context) => {
    const input = await json(context, endpointInput.extend({ url: z.string().trim().max(2_000).optional(), reason }).strict());
    const why = context.get("authority").requireSensitive("platform.webhooks.manage", input.reason);
    const organizationId = await owner(context, context.req.param("id"));
    const { webhooks } = await service(context, organizationId);
    await tenant(() => webhooks.update(operation(context, organizationId, why), context.req.param("id"), input));
    return context.body(null, 204);
  });

  for (const [action, state] of [["pause", "paused"], ["resume", "active"]] as const) {
    admin.post(`/api/admin/webhooks/:id/${action}`, async (context) => {
      const input = await json(context, z.object({ reason }).strict());
      const why = context.get("authority").requireSensitive("platform.webhooks.manage", input.reason);
      const organizationId = await owner(context, context.req.param("id"));
      const { webhooks } = await service(context, organizationId);
      await tenant(() => webhooks.setState(operation(context, organizationId, why), context.req.param("id"), state));
      return context.body(null, 204);
    });
  }

  admin.post("/api/admin/webhooks/:id/test", async (context) => {
    const input = await json(context, z.object({ reason }).strict());
    const why = context.get("authority").requireSensitive("platform.webhooks.manage", input.reason);
    const organizationId = await owner(context, context.req.param("id"));
    const { webhooks } = await service(context, organizationId);
    // Queued as a marked test; the delivery runner attempts it within the minute (seconds under trestle dev).
    const deliveryId = await tenant(() => webhooks.sendTest(operation(context, organizationId, why), context.req.param("id")));
    return context.json({ deliveryId }, 202);
  });

  admin.post("/api/admin/webhooks/:id/rotate-secret", async (context) => {
    const input = await json(context, z.object({ overlapHours: z.number().min(0).max(168), reason }).strict());
    const why = context.get("authority").requireSensitive("platform.webhooks.manage", input.reason);
    const organizationId = await owner(context, context.req.param("id"));
    const { webhooks } = await service(context, organizationId);
    const rotated = await tenant(() => webhooks.rotateSecret(operation(context, organizationId, why), context.req.param("id"), input.overlapHours));
    context.header("cache-control", "no-store");
    return context.json({ secret: rotated.secret, fingerprint: rotated.fingerprint, previousExpiresAt: rotated.previousExpiresAt.toISOString() });
  });

  admin.delete("/api/admin/webhooks/:id", async (context) => {
    const input = await json(context, z.object({ reason }).strict());
    const why = context.get("authority").requireSensitive("platform.webhooks.manage", input.reason);
    const organizationId = await owner(context, context.req.param("id"));
    const { webhooks } = await service(context, organizationId);
    await tenant(() => webhooks.delete(operation(context, organizationId, why), context.req.param("id"), why));
    return context.body(null, 204);
  });
}
