import { Hono } from "hono";
import { cors } from "hono/cors";

import { createAuth, type AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { getPlan, planEntitlements, plans } from "@__TRESTLE_PROJECT_NAME__/billing";
import { healthResponseSchema } from "@__TRESTLE_PROJECT_NAME__/contracts";
import { createLogger, createMetrics, loggerSecretsFromEnvironment, safeErrorDiagnostic } from "@__TRESTLE_PROJECT_NAME__/context";
import { applyBillingNotificationEvent, applyBillingProviderEvent, beginBillingSubscriptionReconciliation, createDatabase, emailDeliveryEvent, listWebhookAttempts, listWebhookDeliveries, listWebhookEndpoints, listWebhookSubscriptions, markBillingReconciliationUnavailable, createTenantDatabase, PostgresEventInbox, PostgresOutboxStore, replayTenantWebhookDelivery, replaceWebhookSubscriptions, setWebhookEndpointState, WebhookSecretError, WebhookSecretService } from "@__TRESTLE_PROJECT_NAME__/db";
import { applicationEventCatalog, type CloudflareQueueBinding, type EventEnvelope, type QueueSettlement } from "@__TRESTLE_PROJECT_NAME__/events";
import { clearCapturedEmails, getCapturedEmail, listCapturedEmails, LocalBillingAdapter, LocalEmailAdapter, NativeWebhookDestinationError, retrieveCurrentStripeSubscription, verifyAndNormalizeStripeEvent, verifyResendWebhook } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq } from "drizzle-orm";
import { createQueueConsumer, createWorkflowQueueConsumer, dispatchQueuedOutbox, EventConsumerRegistry, type CloudflareWorkflowBinding, type QueueBatch } from "./async-runtime.js";
import { maintainArtifacts } from "./artifact-maintenance.js";
import { auditArtifactReferences } from "./artifact-reference-audit.js";
import { auditArtifactOrphans } from "./artifact-orphan-audit.js";
import { artifactRuntimeReady, artifactSigner, artifactStore, publicArtifactUrl } from "./artifact-runtime.js";
import { accessRoutes } from "./access-routes.js";
import { machineAccessRoutes } from "./machine-access-routes.js";
import { regionalRoutes } from "./regional-routes.js";
import { auditTenantAction } from "./audit.js";
import { requireExecutionContext, type AppVariables } from "./execution-context.js";
import { mapHttpError } from "./http-errors.js";
import { createBillingService, stripeConfigurationReady } from "./services.js";
import { hasCurrentEntitlement, projectWebhookForEvent } from "./webhook-runtime.js";
import { maintainWebhookPayloads } from "./webhook-retention.js";
import { maintainReadyArtifacts } from "./artifact-retention.js";
import { maintainNativeWebhookDeliveries } from "./webhook-recovery.js";
import { consumeNativeWebhookQueueMessages, looksLikeNativeWebhookWakeup } from "./webhook-native-queue.js";
import type { Database, NativeWebhookWakeup } from "@__TRESTLE_PROJECT_NAME__/db";
import { z } from "zod";

export const app = new Hono<{ Bindings: AuthEnvironment; Variables: AppVariables }>();
/** Background handlers run only on verified committed events. `{ authority: "tenant" }` handlers get a lazily opened tenant database. */
export const eventConsumers = new EventConsumerRegistry<AuthEnvironment, Database>(applicationEventCatalog, {
  tenantData: (environment, organizationId) => createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId),
  closeTenantData: async (data) => { await data.$client.end(); },
  hasEntitlement: hasCurrentEntitlement,
});

app.use("*", async (context, next) => {
  const supplied = context.req.header("x-correlation-id");
  const correlationId = supplied && /^[A-Za-z0-9._:-]{1,128}$/u.test(supplied) ? supplied : crypto.randomUUID();
  const requestStartedAt = Date.now();
  context.set("correlationId", correlationId);
  context.set("requestStartedAt", requestStartedAt);
  context.header("x-correlation-id", correlationId);
  const log = createLogger({ correlationId }, undefined, { secretValues: loggerSecretsFromEnvironment(context.env) });
  log.info("http.request.started", { method: context.req.method, path: new URL(context.req.url).pathname });
  await next();
  log.info("http.request.completed", { method: context.req.method, path: new URL(context.req.url).pathname, status: context.res.status, durationMs: Date.now() - requestStartedAt });
  createMetrics(log).observe("http.request.duration_ms", Date.now() - requestStartedAt, { method: context.req.method, status: String(context.res.status) });
});

app.use("/api/*", async (context, next) =>
  cors({ origin: context.env.WEB_ORIGIN ?? context.env.BETTER_AUTH_URL ?? "http://localhost:42069", credentials: true })(context, next),
);

function localEmailEnabled(environment: AuthEnvironment): boolean {
  return environment.APP_ENV === "local"
    && (!environment.EMAIL_DELIVERY_MODE || environment.EMAIL_DELIVERY_MODE === "capture" || environment.EMAIL_DELIVERY_MODE === "local");
}

function configuredValue(value: string | undefined): boolean {
  return Boolean(value?.trim() && value.trim() !== "CHANGE_ME");
}

function inspectionPageSize(value: string | undefined): number | null {
  if (value === undefined) return 50;
  if (!/^[1-9][0-9]{0,2}$/u.test(value)) return null;
  const size = Number(value);
  return size <= 100 ? size : null;
}

function validWebhookDeliveryId(value: string): boolean {
  return /^whd_(?:[0-9a-f]{64}|replay_[0-9a-f]{32})$/u.test(value);
}

const webhookSubscriptionsSchema = z.array(z.object({ type: z.string(), version: z.number().int().positive() }).strict()).min(1).max(100);
const createWebhookEndpointSchema = z.object({
  name: z.string().trim().min(1).max(120),
  destinationUrl: z.url().max(2048),
  subscriptions: webhookSubscriptionsSchema,
}).strict();
const billingRequestIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
const checkoutRequestSchema = z.object({ plan: z.string().trim().min(1).max(64), requestId: billingRequestIdSchema }).strict();
const portalRequestSchema = z.object({ requestId: billingRequestIdSchema }).strict();

app.get("/api/developer/webhooks/events", requireExecutionContext, (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.webhooks.read" });
  return context.json({ events: applicationEventCatalog.publicEvents().map(({ schema, examples, ...event }) => ({
    ...event, schema, examples,
    available: !event.entitlement || execution.entitlements.has(event.entitlement),
  })) });
});

app.post("/api/developer/webhooks/endpoints", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.webhooks.manage" });
  const origin = context.req.header("origin");
  const expectedOrigin = context.env.WEB_ORIGIN ?? context.env.BETTER_AUTH_URL ?? "http://localhost:42069";
  if (!origin || origin !== expectedOrigin) return context.json({ error: "Invalid request origin" }, 403);
  if (!context.req.header("content-type")?.toLowerCase().startsWith("application/json")) return context.json({ error: "JSON content type required" }, 415);
  if (!context.env.WEBHOOK_SECRET_KEY || new TextEncoder().encode(context.env.WEBHOOK_SECRET_KEY).length < 32) {
    return context.json({ error: "Webhook signing key is not configured" }, 503);
  }
  let body: unknown;
  try { body = await context.req.json(); }
  catch { return context.json({ error: "Invalid JSON body" }, 400); }
  const parsed = createWebhookEndpointSchema.safeParse(body);
  if (!parsed.success) return context.json({ error: "Invalid webhook endpoint" }, 400);
  const availableEvents = applicationEventCatalog.publicEvents().filter((event) => !event.entitlement || execution.entitlements.has(event.entitlement));
  const provider = context.env.APP_ENV === "local" || !context.env.APP_ENV ? "local" : "native";
  try {
    const service = new WebhookSecretService({
      tenantDatabase: () => execution.data,
      masterKey: context.env.WEBHOOK_SECRET_KEY,
      environment: context.env.APP_ENV ?? "local",
      clock: execution.clock,
      authority: { authorize: async () => ({ actorId: execution.principal.id }) },
    });
    const result = await service.registerEndpoint(execution.tenant.organizationId, {
      ...parsed.data, provider, availableEvents,
    });
    execution.log.info("webhooks.endpoint.created", { endpointId: result.endpointId, subscriptionCount: parsed.data.subscriptions.length });
    // The signing secret and destination URL are never part of the audit record.
    await auditTenantAction(execution, context.env.APP_ENV, { name: "webhooks.endpoint.created", target: { type: "webhook_endpoint", id: result.endpointId }, summary: { name: parsed.data.name, provider, subscriptions: parsed.data.subscriptions.length } });
    context.header("Cache-Control", "no-store");
    return context.json({ endpoint: { id: result.endpointId, state: "disabled", name: parsed.data.name }, signingSecret: result.secret }, 201);
  } catch (error) {
    if (error instanceof WebhookSecretError || error instanceof NativeWebhookDestinationError) return context.json({ error: error.message }, 400);
    throw error;
  }
});

app.patch("/api/developer/webhooks/endpoints/:id/state", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.webhooks.manage" });
  const origin = context.req.header("origin");
  const expectedOrigin = context.env.WEB_ORIGIN ?? context.env.BETTER_AUTH_URL ?? "http://localhost:42069";
  if (!origin || origin !== expectedOrigin) return context.json({ error: "Invalid request origin" }, 403);
  const endpointId = context.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(endpointId)) return context.json({ error: "Invalid endpoint ID" }, 400);
  if (!context.req.header("content-type")?.toLowerCase().startsWith("application/json")) return context.json({ error: "JSON content type required" }, 415);
  let body: unknown;
  try { body = await context.req.json(); }
  catch { return context.json({ error: "Invalid JSON body" }, 400); }
  const parsed = z.object({ state: z.enum(["active", "disabled"]) }).strict().safeParse(body);
  if (!parsed.success) return context.json({ error: "Invalid endpoint state" }, 400);
  if (parsed.data.state === "active") {
    const mode = context.env.WEBHOOK_DELIVERY_MODE ?? "disabled";
    const allowed = context.env.APP_ENV === "local" || !context.env.APP_ENV ? mode === "local" : mode === "native" && Boolean((context.env as WorkerEnvironment).TRESTLE_EVENTS);
    if (!allowed) return context.json({ error: "Webhook delivery capability is not configured" }, 409);
  }
  try {
    if (parsed.data.state === "active" && (!context.env.WEBHOOK_SECRET_KEY || new TextEncoder().encode(context.env.WEBHOOK_SECRET_KEY).length < 32)) return context.json({ error: "Webhook signing key is not configured" }, 503);
    const updated = await setWebhookEndpointState({
      organizationId: execution.tenant.organizationId, endpointId, state: parsed.data.state,
      environment: context.env.APP_ENV ?? "local", authority: { authorize: async () => ({ actorId: execution.principal.id }) },
      ...(parsed.data.state === "active" ? { activeProvider: context.env.APP_ENV === "local" || !context.env.APP_ENV ? "local" as const : "native" as const } : {}),
      tenantDatabase: () => execution.data, clock: execution.clock,
    });
    if (!updated) return context.json({ error: "Endpoint not found" }, 404);
    execution.log.info("webhooks.endpoint.state_changed", { endpointId, state: parsed.data.state });
    await auditTenantAction(execution, context.env.APP_ENV, { name: "webhooks.endpoint.state_changed", target: { type: "webhook_endpoint", id: endpointId }, summary: { state: parsed.data.state } });
    return context.json({ endpoint: { id: endpointId, state: parsed.data.state } });
  } catch (error) {
    if (error instanceof WebhookSecretError) return context.json({ error: error.message }, 409);
    throw error;
  }
});

app.get("/api/developer/webhooks/endpoints", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.webhooks.read" });
  const limit = inspectionPageSize(context.req.query("limit"));
  if (!limit) return context.json({ error: "Invalid page size" }, 400);
  return context.json({ endpoints: await listWebhookEndpoints({
    organizationId: execution.tenant.organizationId, environment: context.env.APP_ENV ?? "local",
    tenantDatabase: () => execution.data, limit,
  }) });
});

app.get("/api/developer/webhooks/endpoints/:id/subscriptions", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.webhooks.read" });
  const endpointId = context.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(endpointId)) return context.json({ error: "Invalid endpoint ID" }, 400);
  const subscriptions = await listWebhookSubscriptions({
    organizationId: execution.tenant.organizationId, environment: context.env.APP_ENV ?? "local",
    endpointId, tenantDatabase: () => execution.data,
  });
  return subscriptions ? context.json({ subscriptions }) : context.json({ error: "Endpoint not found" }, 404);
});

app.patch("/api/developer/webhooks/endpoints/:id/subscriptions", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.webhooks.manage" });
  const expectedOrigin = context.env.WEB_ORIGIN ?? context.env.BETTER_AUTH_URL ?? "http://localhost:42069";
  if (!context.req.header("origin") || context.req.header("origin") !== expectedOrigin) return context.json({ error: "Invalid request origin" }, 403);
  const endpointId = context.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(endpointId)) return context.json({ error: "Invalid endpoint ID" }, 400);
  if (!context.req.header("content-type")?.toLowerCase().startsWith("application/json")) return context.json({ error: "JSON content type required" }, 415);
  let body: unknown;
  try { body = await context.req.json(); }
  catch { return context.json({ error: "Invalid JSON body" }, 400); }
  const parsed = z.object({ subscriptions: webhookSubscriptionsSchema }).strict().safeParse(body);
  if (!parsed.success) return context.json({ error: "Invalid webhook subscriptions" }, 400);
  try {
    const updated = await replaceWebhookSubscriptions({
      organizationId: execution.tenant.organizationId, endpointId, environment: context.env.APP_ENV ?? "local",
      authority: { authorize: async () => ({ actorId: execution.principal.id }) },
      tenantDatabase: () => execution.data, clock: execution.clock,
      subscriptions: parsed.data.subscriptions,
      availableEvents: applicationEventCatalog.publicEvents().filter((event) => !event.entitlement || execution.entitlements.has(event.entitlement)),
    });
    if (!updated) return context.json({ error: "Endpoint not found" }, 404);
    execution.log.info("webhooks.endpoint.subscriptions_changed", { endpointId, subscriptionCount: parsed.data.subscriptions.length });
    await auditTenantAction(execution, context.env.APP_ENV, { name: "webhooks.endpoint.subscriptions_changed", target: { type: "webhook_endpoint", id: endpointId }, summary: { subscriptions: parsed.data.subscriptions } });
    return context.json({ subscriptions: parsed.data.subscriptions });
  } catch (error) {
    if (error instanceof WebhookSecretError) return context.json({ error: error.message }, 400);
    throw error;
  }
});

app.get("/api/developer/webhooks/endpoints/:id/deliveries", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.webhooks.deliveries.read" });
  const endpointId = context.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(endpointId)) return context.json({ error: "Invalid endpoint ID" }, 400);
  const limit = inspectionPageSize(context.req.query("limit"));
  if (!limit) return context.json({ error: "Invalid page size" }, 400);
  return context.json({ deliveries: await listWebhookDeliveries({
    organizationId: execution.tenant.organizationId, environment: context.env.APP_ENV ?? "local",
    endpointId, tenantDatabase: () => execution.data, limit, deliveryMode: context.env.WEBHOOK_DELIVERY_MODE ?? "disabled",
  }) });
});

app.get("/api/developer/webhooks/deliveries/:id/attempts", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.webhooks.deliveries.read" });
  const deliveryId = context.req.param("id");
  if (!validWebhookDeliveryId(deliveryId)) return context.json({ error: "Invalid delivery ID" }, 400);
  const limit = inspectionPageSize(context.req.query("limit"));
  if (!limit) return context.json({ error: "Invalid page size" }, 400);
  return context.json({ attempts: await listWebhookAttempts({
    organizationId: execution.tenant.organizationId, environment: context.env.APP_ENV ?? "local",
    deliveryId, tenantDatabase: () => execution.data, limit,
  }) });
});

app.post("/api/developer/webhooks/deliveries/:id/replay", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.webhooks.replay", rejectApiKeys: true });
  const expectedOrigin = context.env.WEB_ORIGIN ?? context.env.BETTER_AUTH_URL ?? "http://localhost:42069";
  if (context.req.header("origin") !== expectedOrigin) return context.json({ error: "Invalid request origin" }, 403);
  const deliveryId = context.req.param("id");
  if (!validWebhookDeliveryId(deliveryId)) return context.json({ error: "Invalid delivery ID" }, 400);
  const environment = context.env.APP_ENV ?? "local";
  const expectedMode = environment === "local" ? "local" : "native";
  if (context.env.WEBHOOK_DELIVERY_MODE !== expectedMode) return context.json({ error: "Webhook replay is unavailable in this environment" }, 503);
  const result = await replayTenantWebhookDelivery({
    organizationId: execution.tenant.organizationId, environment,
    deliveryId, actorId: execution.principal.id, correlationId: execution.correlation.correlationId,
    database: execution.data, now: execution.clock.now(),
  });
  if (result.state === "not_found") return context.json({ error: "Delivery not found" }, 404);
  if (result.state === "not_terminal") return context.json({ error: "Only failed deliveries can be replayed" }, 409);
  if (result.state === "payload_gone") return context.json({ error: "The event payload is no longer retained" }, 409);
  if (result.state === "endpoint_inactive") return context.json({ error: "The endpoint must be active" }, 409);
  if (result.state === "already_succeeded") return context.json({ error: "A replay has already succeeded" }, 409);
  if (result.state === "provenance_expired") return context.json({ error: "The source event is outside the 14-day replay window or no longer retained" }, 409);
  if (!("deliveryId" in result)) throw new Error("Unexpected webhook replay result");
  execution.log.info("webhooks.delivery.replay_queued", { sourceDeliveryId: deliveryId, replayDeliveryId: result.deliveryId, created: result.state === "created" });
  return context.json({ state: "queued", replayDeliveryId: result.deliveryId, created: result.state === "created" }, result.state === "created" ? 202 : 200);
});

app.get("/api/dev/emails", (context) => {
  if (!localEmailEnabled(context.env)) return context.notFound();
  return context.json({ emails: listCapturedEmails() });
});

app.get("/api/dev/emails/:id", (context) => {
  if (!localEmailEnabled(context.env)) return context.notFound();
  const email = getCapturedEmail(context.req.param("id"));
  return email ? context.json({ email }) : context.json({ error: "Not found" }, 404);
});

app.delete("/api/dev/emails", (context) => {
  if (!localEmailEnabled(context.env)) return context.notFound();
  clearCapturedEmails();
  return context.body(null, 204);
});

app.post("/api/dev/emails/flush", async (context) => {
  if (!localEmailEnabled(context.env)) return context.notFound();
  return context.json({ flushed: await new LocalEmailAdapter().flushScheduledEmail() });
});

app.post("/api/webhooks/resend", async (context) => {
  const log = createLogger({ correlationId: context.get("correlationId"), provider: "resend" }, undefined, { secretValues: loggerSecretsFromEnvironment(context.env) });
  if (!context.env.RESEND_API_KEY || !context.env.RESEND_WEBHOOK_SECRET) return context.json({ error: "Email webhook is not configured" }, 503);
  const id = context.req.header("svix-id");
  const timestamp = context.req.header("svix-timestamp");
  const signature = context.req.header("svix-signature");
  if (!id || !timestamp || !signature) return context.json({ error: "Missing webhook signature" }, 400);
  let event: Awaited<ReturnType<typeof verifyResendWebhook>>;
  try {
    event = await verifyResendWebhook({ apiKey: context.env.RESEND_API_KEY, webhookSecret: context.env.RESEND_WEBHOOK_SECRET, rawBody: await context.req.text(), headers: { id, timestamp, signature } });
  } catch {
    log.warn("email.webhook.rejected", { reason: "invalid_signature_or_payload" });
    return context.json({ error: "Invalid webhook" }, 400);
  }
  try {
    const inserted = await createDatabase(context.env.DATABASE_URL, context.env.DATABASE_DRIVER).insert(emailDeliveryEvent).values(event).onConflictDoNothing().returning();
    const duplicate = inserted.length === 0;
    log.info(duplicate ? "email.webhook.duplicate" : "email.webhook.processed", { providerEventId: event.id, emailDeliveryId: event.emailDeliveryId, deliveryStatus: event.status });
    return context.json({ duplicate, event }, duplicate ? 200 : 202);
  } catch {
    log.error("email.webhook.persistence_failed", { providerEventId: event.id, emailDeliveryId: event.emailDeliveryId });
    return context.json({ error: "Email webhook could not be recorded" }, 503);
  }
});

app.post("/webhooks/stripe", async (context) => {
  const log = createLogger({ correlationId: context.get("correlationId"), provider: "stripe" }, undefined, { secretValues: loggerSecretsFromEnvironment(context.env) });
  if (!context.env.STRIPE_WEBHOOK_SECRET) return context.json({ error: "Stripe webhook is not configured" }, 503);
  const signature = context.req.header("stripe-signature");
  if (!signature) return context.json({ error: "Missing Stripe signature" }, 400);
  let event: Awaited<ReturnType<typeof verifyAndNormalizeStripeEvent>>;
  try { event = await verifyAndNormalizeStripeEvent(await context.req.text(), signature, context.env.STRIPE_WEBHOOK_SECRET); }
  catch (error) { log.warn("billing.webhook.rejected", { reason: "invalid_signature_or_payload", ...safeErrorDiagnostic(error) }); return context.json({ error: "Invalid Stripe webhook" }, 400); }
  const subscriptionEvent = event.type.startsWith("Subscription");
  let generation: number | undefined;
  if (subscriptionEvent && (context.env.STRIPE_MODE ?? "local") !== "local") {
    if (!context.env.STRIPE_SECRET_KEY || !event.providerSubscriptionId) return context.json({ error: "Stripe reconciliation is not configured" }, 503);
    const claim = await beginBillingSubscriptionReconciliation({ databaseUrl: context.env.DATABASE_URL,
      ...(context.env.DATABASE_DRIVER ? { driver: context.env.DATABASE_DRIVER } : {}),
      provider: "stripe", providerEventId: event.id, providerSubscriptionId: event.providerSubscriptionId, type: event.type });
    if (claim.duplicate) {
      log.info("billing.webhook.duplicate", { providerEventId: event.id, type: event.type });
      return context.json({ duplicate: true }, 200);
    }
    generation = claim.generation;
    try { event = await retrieveCurrentStripeSubscription({ secretKey: context.env.STRIPE_SECRET_KEY, event }); }
    catch (error) {
      await markBillingReconciliationUnavailable({ databaseUrl: context.env.DATABASE_URL,
        ...(context.env.DATABASE_DRIVER ? { driver: context.env.DATABASE_DRIVER } : {}),
        provider: "stripe", providerEventId: event.id }).catch(() => undefined);
      throw error;
    }
  }
  if (event.type === "BillingCheckoutCompleted" || event.type === "InvoicePaid" || event.type === "InvoicePaymentFailed") {
    const result = await applyBillingNotificationEvent({ databaseUrl: context.env.DATABASE_URL,
      ...(context.env.DATABASE_DRIVER ? { driver: context.env.DATABASE_DRIVER } : {}),
      provider: "stripe", providerEventId: event.id, providerSubscriptionId: event.providerSubscriptionId!,
      ...(event.providerCustomerId ? { providerCustomerId: event.providerCustomerId } : {}),
      type: event.type, ...(event.organizationId ? { organizationId: event.organizationId } : {}),
      correlationId: context.get("correlationId"), occurredAt: event.occurredAt,
      ...(event.paymentStatus ? { paymentStatus: event.paymentStatus } : {}),
      ...(event.amountMinor !== undefined ? { amountMinor: event.amountMinor } : {}),
      ...(event.currency ? { currency: event.currency } : {}),
    });
    if (result.unresolved) {
      log.warn("billing.webhook.ownership_unresolved", { providerEventId: event.id, type: event.type });
      return context.json({ error: "billing_ownership_unresolved", retryable: true }, 503);
    }
    log.info(result.duplicate ? "billing.webhook.duplicate" : "billing.webhook.processed",
      { providerEventId: event.id, type: event.type, organizationId: event.organizationId });
    return context.json({ duplicate: result.duplicate, ...(result.duplicate ? {} : { event }) }, result.duplicate ? 200 : 202);
  }
  const plan = event.plan ? getPlan(event.plan) : undefined;
  if (subscriptionEvent && (!event.organizationId || !event.status || !plan)) {
    log.error("billing.webhook.unresolved_subscription", { providerEventId: event.id, type: event.type });
    return context.json({ error: "Subscription webhook lacks a known organization or plan" }, 422);
  }
  try {
    const result = await applyBillingProviderEvent({ databaseUrl: context.env.DATABASE_URL,
      ...(context.env.DATABASE_DRIVER ? { driver: context.env.DATABASE_DRIVER } : {}),
      provider: "stripe", providerEventId: event.id, type: event.type, correlationId: context.get("correlationId"),
      ...(generation !== undefined && event.providerSubscriptionId ? { reconciliation: { providerSubscriptionId: event.providerSubscriptionId, generation } } : {}),
      ...(subscriptionEvent && event.organizationId && event.status && event.plan && plan ? { projection: {
        organizationId: event.organizationId,
        ...(event.providerCustomerId ? { providerCustomerId: event.providerCustomerId } : {}),
        ...(event.providerSubscriptionId ? { providerSubscriptionId: event.providerSubscriptionId } : {}),
        plan: event.plan, planVersion: plan.version, status: event.status,
        ...(event.cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd: event.cancelAtPeriodEnd } : {}),
        ...(event.currentPeriodStart ? { currentPeriodStart: event.currentPeriodStart } : {}),
        ...(event.currentPeriodEnd ? { currentPeriodEnd: event.currentPeriodEnd } : {}),
        entitlements: event.status === "active" || event.status === "trialing" ? [...(planEntitlements[event.plan as keyof typeof planEntitlements] ?? [])] : [],
      } } : {}),
    });
    log.info(result.duplicate ? "billing.webhook.duplicate" : result.superseded ? "billing.webhook.superseded" : "billing.webhook.processed",
      { providerEventId: event.id, type: event.type, organizationId: event.organizationId });
    return context.json({ duplicate: result.duplicate, ...(result.superseded ? { superseded: true } : {}),
      ...(result.duplicate || result.superseded ? {} : { event }) }, result.duplicate ? 200 : 202);
  } catch (error) {
    log.error("billing.webhook.failed", { providerEventId: event.id, type: event.type });
    throw error;
  }
});

app.post("/api/billing/checkout", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.billing.manage" });
  const parsed = checkoutRequestSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "Invalid checkout request" }, 400);
  const input = parsed.data;
  if (!getPlan(input.plan)) return context.json({ error: "Unknown billing plan" }, 400);
  execution.log.info("billing.checkout.started", { plan: input.plan });
  const checkout = await execution.services.billing.createCheckoutSession({ organizationId: execution.tenant.organizationId, plan: input.plan, requestId: input.requestId, ...(execution.principal.email ? { customerEmail: execution.principal.email } : {}) });
  execution.log.info("billing.checkout.created", { plan: input.plan, checkoutSessionId: checkout.id });
  execution.metrics.increment("billing.checkout.created");
  return context.json(checkout);
});

app.post("/api/billing/portal", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.billing.manage" });
  const parsed = portalRequestSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "Invalid portal request" }, 400);
  const input = parsed.data;
  const portal = await execution.services.billing.createPortalSession({ organizationId: execution.tenant.organizationId, requestId: input.requestId });
  execution.log.info("billing.portal.created", { portalSessionId: portal.id });
  return context.json(portal);
});

app.get("/api/billing/subscription", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  return context.json({ subscription: await execution.services.billing.getSubscription(execution.tenant.organizationId), usage: [] as Array<{ meter: string; used: number; limit: number | null }> });
});

app.post("/api/dev/billing", requireExecutionContext, async (context) => {
  if ((context.env.STRIPE_MODE ?? "local") !== "local") return context.notFound();
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.billing.manage" });
  const input = await context.req.json<{ action: "activate" | "fail-payment" | "cancel"; plan?: string }>();
  const local = execution.services.billing as LocalBillingAdapter;
  if (input.action === "activate") await local.activate({ organizationId: execution.tenant.organizationId, plan: input.plan ?? "starter" });
  else if (input.action === "fail-payment") await local.failPayment({ organizationId: execution.tenant.organizationId });
  else await local.cancel({ organizationId: execution.tenant.organizationId });
  return context.json({ subscription: await local.getSubscription(execution.tenant.organizationId) });
});

app.on(["GET", "POST"], "/api/auth/*", (context) =>
  createAuth(context.env, { correlationId: context.get("correlationId") }).handler(context.req.raw),
);

app.route("/", accessRoutes);
app.route("/", machineAccessRoutes);
app.route("/", regionalRoutes);

app.get("/api/me", async (context) => {
  const session = await createAuth(context.env, { correlationId: context.get("correlationId") }).api.getSession({ headers: context.req.raw.headers });
  if (!session) return context.json({ error: "Unauthorized" }, 401);

  return context.json({ user: session.user, session: session.session });
});

app.get("/api/health", (context) =>
  context.json(
    healthResponseSchema.parse({
      status: "ok",
      service: "__TRESTLE_PROJECT_NAME__-worker",
    }),
  ),
);

app.get("/api/health/operational", (context) => context.json({
  status: "ok",
  environment: context.env.APP_ENV ?? "local",
  capabilities: {
    database: { configured: Boolean(context.env.DATABASE_URL) },
    email: { mode: context.env.EMAIL_DELIVERY_MODE ?? "local", configured: (context.env.EMAIL_DELIVERY_MODE ?? "local") === "local" || Boolean(context.env.RESEND_API_KEY && configuredValue(context.env.EMAIL_FROM)), stagingProtected: !["preview", "staging"].includes(context.env.APP_ENV ?? "local") || configuredValue(context.env.EMAIL_STAGING_REDIRECT) },
    billing: { mode: context.env.STRIPE_MODE ?? "local", configured: stripeConfigurationReady(context.env), plans: Object.keys(plans).length },
    queues: { configured: Boolean((context.env as WorkerEnvironment).TRESTLE_EVENTS) },
    artifacts: { configured: artifactRuntimeReady(context.env), mode: context.env.TRESTLE_ARTIFACTS ? "r2" : context.env.APP_ENV === "local" || !context.env.APP_ENV ? "local" : "unavailable" },
    workflows: { enabled: (context.env as WorkerEnvironment).TRESTLE_WORKFLOWS_ENABLED === "true", configured: Boolean((context.env as WorkerEnvironment).TRESTLE_WORKFLOW) },
  },
}));

/** Matches FRAMEWORK_MAINTENANCE_CRON in scripts/queue-config.mjs, which adds it to deployed Workers. */
const frameworkMaintenanceCron = "* * * * *";
const artifactIdPattern =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// Artifacts are product resources: only application-plane authority grants them.
// Organization roles, including Owner, never imply application actions.
export function canAccessArtifacts(execution: Pick<AppVariables["execution"], "access">, permission: "resource.read" | "resource.write"): boolean {
  return execution.access.check({ permission });
}

app.post("/api/artifacts", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  if (!canAccessArtifacts(execution, "resource.write")) return context.json({ error: "Forbidden" }, 403);
  if (!artifactRuntimeReady(context.env)) return context.json({ error: "Artifact storage is not configured" }, 503);
  const declaredLength = Number(context.req.header("content-length") ?? 0);
  if (!Number.isSafeInteger(declaredLength) || declaredLength > 10 * 1024 * 1024) return context.json({ error: "Artifact exceeds 10 MiB" }, 413);
  const body = new Uint8Array(await context.req.arrayBuffer());
  if (body.byteLength === 0 || body.byteLength > 10 * 1024 * 1024) return context.json({ error: "Artifact must be 1 byte to 10 MiB" }, 413);
  const contentType = context.req.header("content-type") ?? "application/octet-stream";
  if (contentType.length > 128 || /[\r\n]/u.test(contentType)) return context.json({ error: "Invalid content type" }, 400);
  const id = crypto.randomUUID();
  const artifact = await artifactStore(context.env, execution.tenant.organizationId).put({ id, organizationId: execution.tenant.organizationId, key: id, contentType, body });
  execution.log.info("artifact.created", { artifactId: id, size: artifact.size });
  return context.json({ artifact }, 201);
});

app.get("/api/artifacts/:id/access", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  if (!canAccessArtifacts(execution, "resource.read")) return context.json({ error: "Forbidden" }, 403);
  if (!artifactRuntimeReady(context.env)) return context.json({ error: "Artifact storage is not configured" }, 503);
  const id = context.req.param("id");
  if (!artifactIdPattern.test(id)) return context.notFound();
  const artifact = await artifactStore(context.env, execution.tenant.organizationId).get(execution.tenant.organizationId, id);
  if (!artifact) return context.notFound();
  const signed = await artifactSigner(context.env).create(execution.tenant.organizationId, id);
  return context.json({ url: publicArtifactUrl(signed.url, context.env, context.req.url), expiresAt: signed.expiresAt });
});

app.delete("/api/artifacts/:id", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  if (!canAccessArtifacts(execution, "resource.write")) return context.json({ error: "Forbidden" }, 403);
  if (!artifactRuntimeReady(context.env)) return context.json({ error: "Artifact storage is not configured" }, 503);
  const id = context.req.param("id");
  if (!artifactIdPattern.test(id)) return context.notFound();
  const deleted = await artifactStore(context.env, execution.tenant.organizationId).delete(execution.tenant.organizationId, id);
  if (!deleted) return context.notFound();
  execution.log.info("artifact.deleted", { artifactId: id });
  return context.body(null, 204);
});

app.get("/artifacts/:id", async (context) => {
  if (!artifactRuntimeReady(context.env)) return context.notFound();
  const id = context.req.param("id");
  const organizationId = context.req.query("organization") ?? "";
  const expiresAt = Number(context.req.query("expires"));
  const signature = context.req.query("signature") ?? "";
  if (!artifactIdPattern.test(id) || !/^[A-Za-z0-9_-]+$/u.test(organizationId)
    || !await artifactSigner(context.env).verify({ organizationId, artifactId: id, expiresAt, signature })) return context.notFound();
  const artifact = await artifactStore(context.env, organizationId).get(organizationId, id);
  if (!artifact) return context.notFound();
  return new Response(artifact.body as BodyInit, { headers: {
    "content-type": artifact.contentType,
    "content-disposition": `attachment; filename="${id}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  } });
});

app.onError((error, context) => {
  const mapped = mapHttpError(error);
  createLogger({ correlationId: context.get("correlationId") }, undefined, { secretValues: loggerSecretsFromEnvironment(context.env) }).error("http.request.failed", { code: mapped.code, retryable: mapped.retryable, durationMs: Date.now() - context.get("requestStartedAt"), ...safeErrorDiagnostic(error) });
  return context.json({ error: mapped.code, message: mapped.message, retryable: mapped.retryable }, mapped.status);
});

type WorkerEnvironment = AuthEnvironment & { TRESTLE_EVENTS?: CloudflareQueueBinding<EventEnvelope | NativeWebhookWakeup>; TRESTLE_WORKFLOW?: CloudflareWorkflowBinding; TRESTLE_WORKFLOWS_ENABLED?: string };
export default {
  fetch: app.fetch.bind(app),
  queue: async (batch: QueueBatch, environment: WorkerEnvironment) => {
    const observeEvent = ({ outcome, reason, event }: QueueSettlement) => {
      const log = createLogger({ environment: environment.APP_ENV ?? "local", ...(event ? { correlationId: event.correlationId, ...(event.causationId ? { causationId: event.causationId } : {}) } : {}) }, undefined, { secretValues: loggerSecretsFromEnvironment(environment) });
      const fields = event ? { eventId: event.id, eventName: event.name, schemaVersion: event.schemaVersion } : { validated: false };
      if (outcome === "acknowledged") log.info("queue.event.acknowledged", fields);
      // Rejected messages still retry into the dead-letter queue; the reason never includes the payload.
      else if (reason) log.warn("queue.event.rejected", { ...fields, reason });
      else log.warn("queue.event.retried", fields);
    };
    if (environment.TRESTLE_WORKFLOWS_ENABLED === "true" && !environment.TRESTLE_WORKFLOW) {
      throw new Error("Enabled Workflows require the TRESTLE_WORKFLOW binding");
    }
    const nativeMessages = batch.messages.filter((message) => looksLikeNativeWebhookWakeup(message.body));
    const eventMessages = batch.messages.filter((message) => !looksLikeNativeWebhookWakeup(message.body));
    let native = { acknowledged: 0, retried: 0 };
    if (nativeMessages.length > 0) {
      const outbox = new PostgresOutboxStore(environment.DATABASE_URL, { assumeApplicationRole: true });
      try { native = await consumeNativeWebhookQueueMessages({ messages: nativeMessages, environment, outbox }); }
      finally { await outbox.close(); }
    }
    if (eventMessages.length === 0) return native;
    if (environment.TRESTLE_WORKFLOWS_ENABLED === "true") {
      if (!environment.TRESTLE_WORKFLOW) throw new Error("Enabled Workflows require the TRESTLE_WORKFLOW binding");
      // Verify before creating the instance, so a forged message never claims its stable ID.
      const outbox = new PostgresOutboxStore(environment.DATABASE_URL, { assumeApplicationRole: true });
      try {
        const events = await createWorkflowQueueConsumer(eventConsumers, environment.TRESTLE_WORKFLOW, outbox, observeEvent)({ messages: eventMessages }, environment);
        return { acknowledged: native.acknowledged + events.acknowledged, retried: native.retried + events.retried };
      } finally { await outbox.close(); }
    }
    const inbox = new PostgresEventInbox(environment.DATABASE_URL, { assumeApplicationRole: true });
    const outbox = new PostgresOutboxStore(environment.DATABASE_URL, { assumeApplicationRole: true });
    try {
      const events = await createQueueConsumer(eventConsumers, inbox, outbox, async (envelope, currentEnvironment, committed, context) => {
        await projectWebhookForEvent({ envelope, environment: currentEnvironment, outbox, ...(committed ? { committed } : {}), ...(context ? { now: () => context.clock.now() } : {}), ...(environment.TRESTLE_EVENTS ? { queue: environment.TRESTLE_EVENTS } : {}) });
      }, observeEvent)({ messages: eventMessages }, environment);
      return { acknowledged: native.acknowledged + events.acknowledged, retried: native.retried + events.retried };
    } finally { await Promise.all([inbox.close(), outbox.close()]); }
  },
  scheduled: async (event: { cron?: string } | undefined, environment: WorkerEnvironment) => {
    // Application crons declared in wrangler.jsonc arrive with their own expression: handle them here.
    // Framework maintenance runs only on its own tick (or a local invocation that names no cron).
    if (event?.cron !== undefined && event.cron !== frameworkMaintenanceCron) return;
    const log = createLogger({ environment: environment.APP_ENV ?? "local" }, undefined, { secretValues: loggerSecretsFromEnvironment(environment) });
    if (!environment.TRESTLE_EVENTS && !environment.TRESTLE_ARTIFACTS && environment.WEBHOOK_DELIVERY_MODE !== "local") {
      if (!environment.APP_ENV || environment.APP_ENV === "local") return;
      throw new Error("Remote scheduled work requires a Queue or R2 binding");
    }
    if (environment.TRESTLE_EVENTS) {
      const store = new PostgresOutboxStore(environment.DATABASE_URL, { assumeApplicationRole: true });
      try {
        const result = await dispatchQueuedOutbox(store, environment.TRESTLE_EVENTS);
        log.info("outbox.dispatch.completed", result);
      } finally {
        await store.close();
      }
    }
    if (environment.WEBHOOK_DELIVERY_MODE === "native") {
      if (!environment.TRESTLE_EVENTS) throw new Error("Native webhook recovery requires the TRESTLE_EVENTS Queue binding");
      const result = await maintainNativeWebhookDeliveries({ environment, queue: environment.TRESTLE_EVENTS });
      log.info("webhook.native.recovery.completed", result);
      if (result.failed > 0) throw new Error("Native webhook recovery left incomplete work");
    }
    let artifactUnresolved = false;
    if (environment.TRESTLE_ARTIFACTS) {
      try {
        const result = await maintainArtifacts(environment);
        log.info("artifact.maintenance.completed", result);
        const retention = await maintainReadyArtifacts(environment);
        if (retention) log.info("artifact.retention.completed", retention);
        const audit = await auditArtifactReferences(environment, (item) => {
          log.error(`artifact.reference.${item.reason}`, item);
        });
        log.info("artifact.reference.audit.completed", audit);
        const orphans = await auditArtifactOrphans(environment, (item) => {
          log.error(`artifact.orphan.${item.reason}`, item);
        });
        log.info("artifact.orphan.audit.completed", orphans);
        artifactUnresolved = result.failed > 0 || (retention?.failed ?? 0) > 0 || audit.missing > 0 || audit.mismatched > 0 || audit.failed > 0 || orphans.orphaned > 0 || orphans.failed > 0;
      } catch {
        artifactUnresolved = true;
        log.error("artifact.maintenance.unavailable");
      }
    }
    if (environment.WEBHOOK_DELIVERY_MODE === "local" || environment.WEBHOOK_DELIVERY_MODE === "native") {
      const result = await maintainWebhookPayloads(environment);
      log.info("webhook.retention.completed", result);
      if (result.failed > 0) throw new Error("Webhook retention left incomplete cleanup work");
    }
    if (artifactUnresolved) throw new Error("Artifact maintenance or storage audit found unresolved work");
  },
};
