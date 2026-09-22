import { Hono } from "hono";
import { cors } from "hono/cors";

import { createAuth, type AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { getPlan, planEntitlements, plans, PostgresBillingProjectionRepository } from "@__TRESTLE_PROJECT_NAME__/billing";
import { healthResponseSchema } from "@__TRESTLE_PROJECT_NAME__/contracts";
import { createLogger, createMetrics } from "@__TRESTLE_PROJECT_NAME__/context";
import { billingProviderEvent, createDatabase, emailDeliveryEvent } from "@__TRESTLE_PROJECT_NAME__/db";
import { clearCapturedEmails, getCapturedEmail, listCapturedEmails, LocalBillingAdapter, LocalEmailAdapter, verifyAndNormalizeStripeEvent, verifyResendWebhook } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq } from "drizzle-orm";
import { createQueueConsumer, EventConsumerRegistry, type QueueBatch } from "./async-runtime.js";
import { requireExecutionContext, type AppVariables } from "./execution-context.js";
import { mapHttpError } from "./http-errors.js";
import { createBillingService } from "./services.js";

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
    if (event.organizationId && event.status && event.plan) {
      await new PostgresBillingProjectionRepository(context.env.DATABASE_URL, context.env.DATABASE_DRIVER).put({ organizationId: event.organizationId, provider: "stripe", ...(event.providerCustomerId ? { providerCustomerId: event.providerCustomerId } : {}), ...(event.providerSubscriptionId ? { providerSubscriptionId: event.providerSubscriptionId } : {}), plan: event.plan, planVersion: getPlan(event.plan)?.version ?? 1, status: event.status, cancelAtPeriodEnd: event.status === "cancelled", entitlements: event.status === "active" || event.status === "trialing" ? [...(planEntitlements[event.plan as keyof typeof planEntitlements] ?? [])] : [] });
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
  execution.access.require({ plane: "organization", permission: "organization:manage" });
  const input = await context.req.json<{ plan: string; requestId: string }>();
  execution.log.info("billing.checkout.started", { plan: input.plan });
  const checkout = await execution.services.billing.createCheckoutSession({ organizationId: execution.tenant.organizationId, plan: input.plan, requestId: input.requestId, ...(execution.principal.email ? { customerEmail: execution.principal.email } : {}) });
  execution.log.info("billing.checkout.created", { plan: input.plan, checkoutSessionId: checkout.id });
  execution.metrics.increment("billing.checkout.created");
  return context.json(checkout);
});

app.post("/api/billing/portal", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  execution.access.require({ plane: "organization", permission: "organization:manage" });
  const input = await context.req.json<{ requestId: string }>();
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
  execution.access.require({ plane: "organization", permission: "organization:manage" });
  const input = await context.req.json<{ action: "activate" | "fail-payment" | "cancel"; plan?: string }>();
  const local = execution.services.billing as LocalBillingAdapter;
  if (input.action === "activate") await local.activate({ organizationId: execution.tenant.organizationId, plan: input.plan ?? "starter" });
  else if (input.action === "fail-payment") await local.failPayment({ organizationId: execution.tenant.organizationId });
  else await local.cancel({ organizationId: execution.tenant.organizationId });
  return context.json({ subscription: await local.getSubscription(execution.tenant.organizationId) });
});

app.on(["GET", "POST"], "/api/auth/*", (context) =>
  createAuth(context.env).handler(context.req.raw),
);

app.get("/api/me", async (context) => {
  const session = await createAuth(context.env).api.getSession({ headers: context.req.raw.headers });
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
    email: { mode: context.env.EMAIL_DELIVERY_MODE ?? "local", configured: (context.env.EMAIL_DELIVERY_MODE ?? "local") === "local" || Boolean(context.env.RESEND_API_KEY && context.env.EMAIL_FROM), stagingProtected: context.env.APP_ENV !== "staging" || Boolean(context.env.EMAIL_STAGING_REDIRECT) },
    billing: { mode: context.env.STRIPE_MODE ?? "local", configured: (context.env.STRIPE_MODE ?? "local") === "local" || Boolean(context.env.STRIPE_SECRET_KEY && context.env.STRIPE_WEBHOOK_SECRET && context.env.STRIPE_PRICES), plans: Object.keys(plans).length },
  },
}));

app.onError((error, context) => {
  const mapped = mapHttpError(error);
  createLogger({ correlationId: context.get("correlationId") }).error("http.request.failed", { code: mapped.code, retryable: mapped.retryable, durationMs: Date.now() - context.get("requestStartedAt") });
  return context.json({ error: mapped.code, message: mapped.message, retryable: mapped.retryable }, mapped.status);
});

const consumeQueue = createQueueConsumer(eventConsumers);
export default {
  fetch: app.fetch.bind(app),
  queue: async (batch: QueueBatch, environment: AuthEnvironment) => await consumeQueue(batch, environment),
};
