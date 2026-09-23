import { Hono, type Context } from "hono";
import { cors } from "hono/cors";

import { loadAuthPolicy, type AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { planEntitlements, plans, PostgresBillingProjectionRepository } from "@__TRESTLE_PROJECT_NAME__/billing";
import { healthResponseSchema } from "@__TRESTLE_PROJECT_NAME__/contracts";
import { createLogger, createMetrics } from "@__TRESTLE_PROJECT_NAME__/context";
import { billingProviderEvent, createDatabase, emailDeliveryEvent, PostgresEventInbox } from "@__TRESTLE_PROJECT_NAME__/db";
import { resolvePriceMappings } from "@__TRESTLE_PROJECT_NAME__/data";
import type { CloudflareQueueBinding } from "@__TRESTLE_PROJECT_NAME__/events";
import { clearCapturedEmails, getCapturedEmail, listCapturedEmails, LocalBillingAdapter, LocalEmailAdapter, verifyAndNormalizeStripeEvent, verifyResendWebhook } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq } from "drizzle-orm";
import { createQueueConsumer, createWorkflowQueueConsumer, EventConsumerRegistry, type CloudflareWorkflowBinding, type QueueBatch } from "./async-runtime.js";
import { artifactRuntimeReady, artifactSigner, artifactStore } from "./artifact-runtime.js";
import { authCapabilities, workerAuth } from "./auth.js";
import { reportCapabilityStatus } from "./capability-report.js";
import { registerIdentityWebhooks } from "./identity-routes.js";
import { requireExecutionContext, type AppVariables } from "./execution-context.js";
import { mapHttpError } from "./http-errors.js";
import { assertQueueBinding, runOutbox } from "./outbox-runner.js";
import { mappingRunner } from "./services.js";
import { tenantRoutes } from "./tenant-routes.js";

export const app = new Hono<{ Bindings: AuthEnvironment; Variables: AppVariables }>();
export const eventConsumers = new EventConsumerRegistry<AuthEnvironment>();

app.use("*", async (context, next) => {
  const supplied = context.req.header("x-correlation-id");
  const correlationId = supplied && /^[A-Za-z0-9._:-]{1,128}$/u.test(supplied) ? supplied : crypto.randomUUID();
  const requestStartedAt = Date.now();
  context.set("correlationId", correlationId);
  context.set("requestStartedAt", requestStartedAt);
  context.header("x-correlation-id", correlationId);
  const log = createLogger({ correlationId });
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

function configuredPrices(value: string | undefined): boolean {
  if (!configuredValue(value)) return false;
  try {
    const prices: unknown = JSON.parse(value!);
    return Boolean(prices && typeof prices === "object" && !Array.isArray(prices) && Object.keys(prices).length > 0);
  } catch { return false; }
}

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

/**
 * Local webhook receiver for developing against tenant webhooks. Point an
 * endpoint at http://localhost:8787/api/dev/webhook-receiver (or .../fail to
 * simulate a 500). It records headers and bodies in memory, local only.
 */
const receivedWebhooks: Array<{ receivedAt: string; mode: string; webhookId: string | null; timestamp: string | null; signature: string | null; body: unknown }> = [];
async function receiveWebhook(context: Context<{ Bindings: AuthEnvironment; Variables: AppVariables }>, mode: string) {
  if ((context.env.APP_ENV ?? "local") !== "local") return context.notFound();
  const text = await context.req.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  receivedWebhooks.unshift({ receivedAt: new Date().toISOString(), mode, // Svix dispatch signs with the same Standard Webhooks scheme under svix-* header names.
    webhookId: context.req.header("webhook-id") ?? context.req.header("svix-id") ?? null, timestamp: context.req.header("webhook-timestamp") ?? context.req.header("svix-timestamp") ?? null,
    signature: context.req.header("webhook-signature") ?? context.req.header("svix-signature") ?? null, body });
  receivedWebhooks.splice(50);
  return mode === "fail" ? context.json({ error: "simulated failure" }, 500) : context.json({ received: true });
}
app.post("/api/dev/webhook-receiver", (context) => receiveWebhook(context, "ok"));
app.post("/api/dev/webhook-receiver/:mode", (context) => receiveWebhook(context, context.req.param("mode")));
app.get("/api/dev/webhook-receiver", (context) => (context.env.APP_ENV ?? "local") === "local" ? context.json({ received: receivedWebhooks }) : context.notFound());
app.delete("/api/dev/webhook-receiver", (context) => { if ((context.env.APP_ENV ?? "local") !== "local") return context.notFound(); receivedWebhooks.splice(0); return context.body(null, 204); });

app.post("/api/webhooks/resend", async (context) => {
  const log = createLogger({ correlationId: context.get("correlationId"), provider: "resend" });
  if (!context.env.RESEND_API_KEY || !context.env.RESEND_WEBHOOK_SECRET) return context.json({ error: "Email webhook is not configured" }, 503);
  const id = context.req.header("svix-id");
  const timestamp = context.req.header("svix-timestamp");
  const signature = context.req.header("svix-signature");
  if (!id || !timestamp || !signature) return context.json({ error: "Missing webhook signature" }, 400);
  try {
    const event = await verifyResendWebhook({ apiKey: context.env.RESEND_API_KEY, webhookSecret: context.env.RESEND_WEBHOOK_SECRET, rawBody: await context.req.text(), headers: { id, timestamp, signature } });
    const inserted = await createDatabase(context.env.DATABASE_URL, context.env.DATABASE_DRIVER).insert(emailDeliveryEvent).values(event).onConflictDoNothing().returning();
    const duplicate = inserted.length === 0;
    log.info(duplicate ? "email.webhook.duplicate" : "email.webhook.processed", { providerEventId: event.id, emailDeliveryId: event.emailDeliveryId, deliveryStatus: event.status });
    return context.json({ duplicate, event }, duplicate ? 200 : 202);
  } catch {
    log.warn("email.webhook.rejected", { reason: "invalid_signature_or_payload" });
    return context.json({ error: "Invalid webhook" }, 400);
  }
});

app.post("/webhooks/stripe", async (context) => {
  const log = createLogger({ correlationId: context.get("correlationId"), provider: "stripe" });
  if (!context.env.STRIPE_WEBHOOK_SECRET) return context.json({ error: "Stripe webhook is not configured" }, 503);
  const signature = context.req.header("stripe-signature");
  if (!signature) return context.json({ error: "Missing Stripe signature" }, 400);
  let event: ReturnType<typeof verifyAndNormalizeStripeEvent>;
  try { event = verifyAndNormalizeStripeEvent(await context.req.text(), signature, context.env.STRIPE_WEBHOOK_SECRET); }
  catch { log.warn("billing.webhook.rejected", { reason: "invalid_signature_or_payload" }); return context.json({ error: "Invalid Stripe webhook" }, 400); }
  const database = createDatabase(context.env.DATABASE_URL, context.env.DATABASE_DRIVER);
  try {
    const inserted = await database.insert(billingProviderEvent).values({ provider: "stripe", providerEventId: event.id, type: event.type }).onConflictDoNothing().returning();
    if (inserted.length === 0) {
      const [existing] = await database.select().from(billingProviderEvent).where(and(eq(billingProviderEvent.provider, "stripe"), eq(billingProviderEvent.providerEventId, event.id))).limit(1);
      if (existing?.status === "processed") { log.info("billing.webhook.duplicate", { providerEventId: event.id, type: event.type }); return context.json({ duplicate: true }, 200); }
    }
    // Plans resolve from explicit price mappings; checkout metadata is only a fallback for unmapped prices.
    const mapped = await resolvePriceMappings(mappingRunner(context.env), context.env.APP_ENV ?? "local", (event.items ?? []).map((item) => item.priceId));
    const primary = event.items?.map((item) => mapped.get(item.priceId)).find(Boolean);
    const plan = primary?.plan ?? event.plan;
    if (event.organizationId && event.status && plan) {
      await new PostgresBillingProjectionRepository(context.env.DATABASE_URL, context.env.DATABASE_DRIVER).put({
        organizationId: event.organizationId, provider: "stripe", ...(event.providerCustomerId ? { providerCustomerId: event.providerCustomerId } : {}), ...(event.providerSubscriptionId ? { providerSubscriptionId: event.providerSubscriptionId } : {}),
        plan, status: event.status, cancelAtPeriodEnd: event.cancelAtPeriodEnd ?? event.status === "cancelled",
        ...(event.currentPeriodStart ? { currentPeriodStart: event.currentPeriodStart } : {}), ...(event.currentPeriodEnd ? { currentPeriodEnd: event.currentPeriodEnd } : {}),
        entitlements: event.status === "active" || event.status === "trialing" ? [...(planEntitlements[plan as keyof typeof planEntitlements] ?? [])] : [],
        ...(event.items ? { lines: event.items.map((item) => { const mapping = mapped.get(item.priceId); return { providerItemId: item.id, providerPriceId: item.priceId, planVersion: mapping ? `${mapping.plan}@${mapping.planVersion}` : null, offer: mapping?.offer ?? null, quantity: item.quantity }; }) } : {}),
      });
    }
    await database.update(billingProviderEvent).set({ status: "processed", processedAt: new Date() }).where(and(eq(billingProviderEvent.provider, "stripe"), eq(billingProviderEvent.providerEventId, event.id)));
    log.info("billing.webhook.processed", { providerEventId: event.id, type: event.type, organizationId: event.organizationId });
    return context.json({ duplicate: false, event }, 202);
  } catch (error) {
    await database.update(billingProviderEvent).set({ status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "processing failed" }).where(and(eq(billingProviderEvent.provider, "stripe"), eq(billingProviderEvent.providerEventId, event.id))).catch(() => undefined);
    log.error("billing.webhook.failed", { providerEventId: event.id, type: event.type });
    throw error;
  }
});

app.post("/api/billing/checkout", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  const input = await context.req.json<{ plan: string; requestId: string }>();
  execution.log.info("billing.checkout.started", { plan: input.plan });
  const checkout = await (await execution.services.billing()).createCheckoutSession({ organizationId: execution.tenant.organizationId, plan: input.plan, requestId: input.requestId, ...(execution.principal.email ? { customerEmail: execution.principal.email } : {}) });
  execution.log.info("billing.checkout.created", { plan: input.plan, checkoutSessionId: checkout.id });
  execution.metrics.increment("billing.checkout.created");
  return context.json(checkout);
});

app.post("/api/billing/portal", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  const input = await context.req.json<{ requestId: string }>();
  const portal = await (await execution.services.billing()).createPortalSession({ organizationId: execution.tenant.organizationId, requestId: input.requestId });
  execution.log.info("billing.portal.created", { portalSessionId: portal.id });
  return context.json(portal);
});

app.get("/api/billing/subscription", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  return context.json({ subscription: await (await execution.services.billing()).getSubscription(execution.tenant.organizationId) });
});

app.post("/api/dev/billing", requireExecutionContext, async (context) => {
  if ((context.env.STRIPE_MODE ?? "local") !== "local") return context.notFound();
  const execution = context.get("execution");
  const input = await context.req.json<{ action: "activate" | "fail-payment" | "cancel"; plan?: string }>();
  const local = await execution.services.billing() as LocalBillingAdapter;
  if (input.action === "activate") await local.activate({ organizationId: execution.tenant.organizationId, plan: input.plan ?? "starter" });
  else if (input.action === "fail-payment") await local.failPayment({ organizationId: execution.tenant.organizationId });
  else await local.cancel({ organizationId: execution.tenant.organizationId });
  return context.json({ subscription: await local.getSubscription(execution.tenant.organizationId) });
});

app.route("/", tenantRoutes);

app.on(["GET", "POST", "PUT", "PATCH", "DELETE"], "/api/auth/*", async (context) => {
  // The active authentication policy (System -> Authentication) shapes every Better Auth request.
  await loadAuthPolicy(context.env);
  return workerAuth(context.env).handler(context.req.raw);
});

app.get("/api/me", async (context) => {
  await loadAuthPolicy(context.env);
  const session = await workerAuth(context.env).api.getSession({ headers: context.req.raw.headers });
  if (!session) return context.json({ error: "Unauthorized" }, 401);

  return context.json({ user: session.user, session: session.session });
});

/** Which sign-in methods the application offers; the sign-in page adapts without a session. */
app.get("/api/auth-methods", (context) => context.json({
  passkeys: authCapabilities.passkeys,
  twoFactor: authCapabilities.twoFactor,
  sso: authCapabilities.sso === "better-auth" ? "better-auth" : authCapabilities.sso === "workos" && context.env.WORKOS_API_KEY && context.env.WORKOS_CLIENT_ID ? "workos" : "disabled",
  directory: authCapabilities.directory,
}));

registerIdentityWebhooks(app);

app.get("/api/health", (context) => {
  try {
    context.executionCtx.waitUntil(reportCapabilityStatus(context.env).catch(() => false));
  } catch { /* no execution context outside the Workers runtime */ }
  return context.json(
    healthResponseSchema.parse({
      status: "ok",
      service: "__TRESTLE_PROJECT_NAME__-worker",
    }),
  );
});

app.get("/api/health/operational", (context) => context.json({
  status: "ok",
  environment: context.env.APP_ENV ?? "local",
  capabilities: {
    database: { configured: Boolean(context.env.DATABASE_URL) },
    email: { mode: context.env.EMAIL_DELIVERY_MODE ?? "local", configured: (context.env.EMAIL_DELIVERY_MODE ?? "local") === "local" || Boolean(context.env.RESEND_API_KEY && configuredValue(context.env.EMAIL_FROM)), stagingProtected: !["preview", "staging"].includes(context.env.APP_ENV ?? "local") || configuredValue(context.env.EMAIL_STAGING_REDIRECT) },
    billing: { mode: context.env.STRIPE_MODE ?? "local", configured: (context.env.STRIPE_MODE ?? "local") === "local" || Boolean(context.env.STRIPE_SECRET_KEY && context.env.STRIPE_WEBHOOK_SECRET && configuredValue(context.env.STRIPE_PUBLISHABLE_KEY) && configuredPrices(context.env.STRIPE_PRICES) && configuredValue(context.env.BILLING_RETURN_URL)), plans: Object.keys(plans).length },
    artifacts: { configured: artifactRuntimeReady(context.env), mode: context.env.TRESTLE_ARTIFACTS ? "r2" : context.env.APP_ENV === "local" || !context.env.APP_ENV ? "local" : "unavailable" },
    workflows: { enabled: (context.env as WorkerEnvironment).TRESTLE_WORKFLOWS_ENABLED === "true", configured: Boolean((context.env as WorkerEnvironment).TRESTLE_WORKFLOW) },
  },
}));

const artifactIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// Artifacts are product resources: only application-plane authority grants them.
// Organization roles (including Owner) never imply application actions.
function canAccessArtifacts(execution: AppVariables["execution"], permission: "resource.read" | "resource.write"): boolean {
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
  return context.json({ url: new URL(signed.url, context.req.url).toString(), expiresAt: signed.expiresAt });
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
  createLogger({ correlationId: context.get("correlationId") }).error("http.request.failed", { code: mapped.code, retryable: mapped.retryable, durationMs: Date.now() - context.get("requestStartedAt") });
  return context.json({ error: mapped.code, message: mapped.message, retryable: mapped.retryable }, mapped.status);
});

type WorkerEnvironment = AuthEnvironment & { TRESTLE_EVENTS?: CloudflareQueueBinding; TRESTLE_WORKFLOW?: CloudflareWorkflowBinding; TRESTLE_WORKFLOWS_ENABLED?: string };
export default {
  fetch: app.fetch.bind(app),
  queue: async (batch: QueueBatch, environment: WorkerEnvironment) => {
    if (environment.TRESTLE_WORKFLOWS_ENABLED === "true") {
      if (!environment.TRESTLE_WORKFLOW) throw new Error("Enabled Workflows require the TRESTLE_WORKFLOW binding");
      return await createWorkflowQueueConsumer(eventConsumers, environment.TRESTLE_WORKFLOW)(batch);
    }
    const inbox = new PostgresEventInbox(environment.DATABASE_URL, { assumeApplicationRole: true });
    try { return await createQueueConsumer(eventConsumers, inbox)(batch, environment); }
    finally { await inbox.close(); }
  },
  // Publishes committed outbox events to webhooks, notifications, and the queue, then delivers what is due.
  scheduled: async (_controller: unknown, environment: WorkerEnvironment, context?: { waitUntil(promise: Promise<unknown>): void }) => {
    assertQueueBinding(environment);
    const run = runOutbox(environment);
    if (context) context.waitUntil(run); else await run;
  },
};
