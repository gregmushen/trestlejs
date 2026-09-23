import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { endpointHealth, WebhookDomainError, type OperationContext, type WebhookDelivery, type WebhookEndpoint } from "@__TRESTLE_PROJECT_NAME__/domain";
import type { Hono } from "hono";
import { z } from "zod";

import { communicationDependencies, communicationsEnabled, webhookDispatcher, webhookService } from "./communications.js";
import type { AppExecutionContext, AppVariables } from "./execution-context.js";

type Environment = { Bindings: AuthEnvironment; Variables: AppVariables };

const endpointInput = z.object({ name: z.string().min(1).max(80), url: z.string().min(1).max(2_000), events: z.array(z.string()).min(1).max(50), description: z.string().max(500).nullable().optional(), timeoutMs: z.number().int().min(1_000).max(30_000).optional() }).strict();

export function operationContext(execution: AppExecutionContext): OperationContext {
  return {
    organizationId: execution.tenant.organizationId, correlationId: execution.correlation.correlationId, environment: execution.environment, now: execution.clock.now(),
    actor: { type: execution.principal.kind === "service_account" ? "service_account" : execution.principal.kind === "platform_operator" ? "platform_operator" : "user", id: execution.principal.id },
    ...(execution.support ? { support: { sessionId: execution.support.sessionId, reason: execution.support.reason } } : {}),
  };
}

/** Tenant read model: sanitized and full URL for the owning tenant, health, and secret metadata only. */
export const serializeEndpoint = (endpoint: WebhookEndpoint) => ({
  id: endpoint.id, name: endpoint.name, url: endpoint.url, urlDisplay: endpoint.urlDisplay, events: endpoint.events, state: endpoint.state, health: endpointHealth(endpoint),
  disabledReason: endpoint.disabledReason, consecutiveFailures: endpoint.consecutiveFailures,
  secret: { fingerprint: endpoint.secretFingerprint, createdAt: endpoint.secretCreatedAt.toISOString(), previousExpiresAt: endpoint.previousSecretExpiresAt?.toISOString() ?? null },
  verifiedAt: endpoint.verifiedAt?.toISOString() ?? null, lastSuccessAt: endpoint.lastSuccessAt?.toISOString() ?? null, lastFailureAt: endpoint.lastFailureAt?.toISOString() ?? null, createdAt: endpoint.createdAt.toISOString(),
  description: endpoint.description ?? null, timeoutMs: endpoint.timeoutMs ?? 10_000,
});

export const serializeDelivery = (delivery: WebhookDelivery) => ({
  id: delivery.id, endpointId: delivery.endpointId, eventId: delivery.eventId, event: delivery.eventName, version: delivery.eventVersion, status: delivery.status, attempts: delivery.attempts,
  nextAttemptAt: delivery.status === "pending" ? delivery.nextAttemptAt.toISOString() : null, responseCode: delivery.lastResponseCode, failureCategory: delivery.failureCategory,
  correlationId: delivery.correlationId, test: delivery.test, replayOf: delivery.replayOf, createdAt: delivery.createdAt.toISOString(), completedAt: delivery.completedAt?.toISOString() ?? null,
});

/** Integrations -> Webhooks (docs/ADMIN_ADDITIONS_SPEC.md §1). Route policies live in packages/authz/src/routes.ts. */
export function registerWebhookRoutes(routes: Hono<Environment>) {
  for (const path of ["/api/tenant/webhooks", "/api/tenant/webhooks/*", "/api/tenant/webhook-deliveries/*"]) {
    routes.use(path, async (context, next) => {
      if (!communicationsEnabled.webhooks) return context.json({ error: "not_enabled", message: "Webhooks are not enabled for this application" }, 404);
      await next();
    });
  }

  routes.get("/api/tenant/webhooks", async (context) => {
    const execution = context.get("execution");
    const service = await webhookService(context.env, execution.tenant.organizationId);
    const endpoints = await communicationDependencies.webhookRepository(context.env, execution.tenant.organizationId).listEndpoints();
    return context.json({ endpoints: endpoints.map(serializeEndpoint), eventTypes: service.eventTypes() });
  });

  routes.post("/api/tenant/webhooks", async (context) => {
    const execution = context.get("execution");
    const input = endpointInput.parse(await context.req.json().catch(() => ({})));
    const created = await (await webhookService(context.env, execution.tenant.organizationId)).create(operationContext(execution), input);
    context.header("cache-control", "no-store");
    return context.json({ endpoint: serializeEndpoint(created.endpoint), secret: created.secret }, 201);
  });

  routes.get("/api/tenant/webhooks/:id", async (context) => {
    const execution = context.get("execution");
    const repository = communicationDependencies.webhookRepository(context.env, execution.tenant.organizationId);
    const endpoint = await repository.getEndpoint(context.req.param("id"));
    if (!endpoint) throw new WebhookDomainError("not_found", "Webhook endpoint not found");
    return context.json({ endpoint: serializeEndpoint(endpoint), deliveries: (await repository.listDeliveries(endpoint.id, 50)).map(serializeDelivery) });
  });

  routes.patch("/api/tenant/webhooks/:id", async (context) => {
    const execution = context.get("execution");
    await (await webhookService(context.env, execution.tenant.organizationId)).update(operationContext(execution), context.req.param("id"), endpointInput.parse(await context.req.json().catch(() => ({}))));
    return context.body(null, 204);
  });

  routes.delete("/api/tenant/webhooks/:id", async (context) => {
    const execution = context.get("execution");
    await (await webhookService(context.env, execution.tenant.organizationId)).delete(operationContext(execution), context.req.param("id"));
    return context.body(null, 204);
  });

  for (const [action, state] of [["pause", "paused"], ["resume", "active"], ["disable", "disabled"]] as const) {
    routes.post(`/api/tenant/webhooks/:id/${action}`, async (context) => {
      const execution = context.get("execution");
      const input = z.object({ reason: z.string().max(500).optional() }).parse(await context.req.json().catch(() => ({})));
      await (await webhookService(context.env, execution.tenant.organizationId)).setState(operationContext(execution), context.req.param("id"), state, input.reason);
      return context.body(null, 204);
    });
  }

  /** Sends a marked test event and attempts it immediately; a 2xx verifies the endpoint. */
  routes.post("/api/tenant/webhooks/:id/test", async (context) => {
    const execution = context.get("execution");
    const operation = operationContext(execution);
    const deliveryId = await (await webhookService(context.env, execution.tenant.organizationId)).sendTest(operation, context.req.param("id"));
    await (await webhookDispatcher(context.env, execution.tenant.organizationId)).attempt(deliveryId, operation);
    const delivery = await communicationDependencies.webhookRepository(context.env, execution.tenant.organizationId).getDelivery(deliveryId);
    return context.json({ delivery: delivery ? serializeDelivery(delivery) : null });
  });

  routes.post("/api/tenant/webhooks/:id/rotate-secret", async (context) => {
    const execution = context.get("execution");
    const input = z.object({ overlapHours: z.number().min(0).max(168).default(24) }).parse(await context.req.json().catch(() => ({})));
    const rotated = await (await webhookService(context.env, execution.tenant.organizationId)).rotateSecret(operationContext(execution), context.req.param("id"), input.overlapHours);
    context.header("cache-control", "no-store");
    return context.json({ secret: rotated.secret, fingerprint: rotated.fingerprint, previousExpiresAt: rotated.previousExpiresAt.toISOString() }, 201);
  });

  routes.get("/api/tenant/webhook-deliveries/:id", async (context) => {
    const execution = context.get("execution");
    const repository = communicationDependencies.webhookRepository(context.env, execution.tenant.organizationId);
    const delivery = await repository.getDelivery(context.req.param("id"));
    if (!delivery) throw new WebhookDomainError("not_found", "Delivery not found");
    return context.json({ delivery: serializeDelivery(delivery), attempts: (await repository.listAttempts(delivery.id)).map((attempt) => ({ ...attempt, attemptedAt: attempt.attemptedAt.toISOString() })) });
  });

  routes.post("/api/tenant/webhook-deliveries/:id/replay", async (context) => {
    const execution = context.get("execution");
    const id = await (await webhookService(context.env, execution.tenant.organizationId)).replay(operationContext(execution), context.req.param("id"));
    return context.json({ deliveryId: id }, 201);
  });
}
