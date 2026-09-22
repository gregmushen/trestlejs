import { Hono } from "hono";
import { cors } from "hono/cors";

import { createAuth, type AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { planEntitlements, PostgresBillingProjectionRepository } from "@__TRESTLE_PROJECT_NAME__/billing";
import { healthResponseSchema } from "@__TRESTLE_PROJECT_NAME__/contracts";
import { billingProviderEvent, createDatabase, emailDeliveryEvent } from "@__TRESTLE_PROJECT_NAME__/db";
import { clearCapturedEmails, getCapturedEmail, listCapturedEmails, LocalBillingAdapter, LocalEmailAdapter, StripeBillingAdapter, verifyAndNormalizeStripeEvent, verifyResendWebhook } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq } from "drizzle-orm";

const app = new Hono<{ Bindings: AuthEnvironment }>();

function billing(environment: AuthEnvironment) {
  const repository = new PostgresBillingProjectionRepository(environment.DATABASE_URL, environment.DATABASE_DRIVER);
  if ((environment.STRIPE_MODE ?? "local") === "local") return new LocalBillingAdapter(repository, planEntitlements);
  let prices: Record<string, string> = {};
  try { prices = JSON.parse(environment.STRIPE_PRICES ?? "{}"); } catch { throw new Error("STRIPE_PRICES must be a JSON object"); }
  return new StripeBillingAdapter({ secretKey: environment.STRIPE_SECRET_KEY ?? "", prices, returnUrl: environment.BILLING_RETURN_URL ?? `${environment.WEB_ORIGIN ?? "http://localhost:42069"}/settings/billing`, repository });
}

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
  if (!context.env.RESEND_API_KEY || !context.env.RESEND_WEBHOOK_SECRET) return context.json({ error: "Email webhook is not configured" }, 503);
  const id = context.req.header("svix-id");
  const timestamp = context.req.header("svix-timestamp");
  const signature = context.req.header("svix-signature");
  if (!id || !timestamp || !signature) return context.json({ error: "Missing webhook signature" }, 400);
  try {
    const event = await verifyResendWebhook({ apiKey: context.env.RESEND_API_KEY, webhookSecret: context.env.RESEND_WEBHOOK_SECRET, rawBody: await context.req.text(), headers: { id, timestamp, signature } });
    const inserted = await createDatabase(context.env.DATABASE_URL, context.env.DATABASE_DRIVER).insert(emailDeliveryEvent).values(event).onConflictDoNothing().returning();
    const duplicate = inserted.length === 0;
    return context.json({ duplicate, event }, duplicate ? 200 : 202);
  } catch {
    return context.json({ error: "Invalid webhook" }, 400);
  }
});

app.post("/webhooks/stripe", async (context) => {
  if (!context.env.STRIPE_WEBHOOK_SECRET) return context.json({ error: "Stripe webhook is not configured" }, 503);
  const signature = context.req.header("stripe-signature");
  if (!signature) return context.json({ error: "Missing Stripe signature" }, 400);
  try {
    const event = verifyAndNormalizeStripeEvent(await context.req.text(), signature, context.env.STRIPE_WEBHOOK_SECRET);
    const database = createDatabase(context.env.DATABASE_URL, context.env.DATABASE_DRIVER);
    const inserted = await database.insert(billingProviderEvent).values({ provider: "stripe", providerEventId: event.id, type: event.type }).onConflictDoNothing().returning();
    if (inserted.length === 0) {
      const [existing] = await database.select().from(billingProviderEvent).where(and(eq(billingProviderEvent.provider, "stripe"), eq(billingProviderEvent.providerEventId, event.id))).limit(1);
      if (existing?.status === "processed") return context.json({ duplicate: true }, 200);
    }
    if (event.organizationId && event.status && event.plan) {
      await new PostgresBillingProjectionRepository(context.env.DATABASE_URL, context.env.DATABASE_DRIVER).put({ organizationId: event.organizationId, provider: "stripe", ...(event.providerCustomerId ? { providerCustomerId: event.providerCustomerId } : {}), ...(event.providerSubscriptionId ? { providerSubscriptionId: event.providerSubscriptionId } : {}), plan: event.plan, status: event.status, cancelAtPeriodEnd: event.status === "cancelled", entitlements: event.status === "active" || event.status === "trialing" ? [...(planEntitlements[event.plan as keyof typeof planEntitlements] ?? [])] : [] });
    }
    await database.update(billingProviderEvent).set({ status: "processed", processedAt: new Date() }).where(and(eq(billingProviderEvent.provider, "stripe"), eq(billingProviderEvent.providerEventId, event.id)));
    return context.json({ duplicate: false, event }, 202);
  } catch {
    return context.json({ error: "Invalid Stripe webhook" }, 400);
  }
});

app.post("/api/billing/checkout", async (context) => {
  const session = await createAuth(context.env).api.getSession({ headers: context.req.raw.headers });
  const organizationId = session?.session.activeOrganizationId;
  if (!session || !organizationId) return context.json({ error: "An active organization is required" }, 401);
  const input = await context.req.json<{ plan: string; requestId: string }>();
  return context.json(await billing(context.env).createCheckoutSession({ organizationId, plan: input.plan, requestId: input.requestId, customerEmail: session.user.email }));
});

app.post("/api/billing/portal", async (context) => {
  const session = await createAuth(context.env).api.getSession({ headers: context.req.raw.headers });
  const organizationId = session?.session.activeOrganizationId;
  if (!session || !organizationId) return context.json({ error: "An active organization is required" }, 401);
  const input = await context.req.json<{ requestId: string }>();
  return context.json(await billing(context.env).createPortalSession({ organizationId, requestId: input.requestId }));
});

app.get("/api/billing/subscription", async (context) => {
  const session = await createAuth(context.env).api.getSession({ headers: context.req.raw.headers });
  const organizationId = session?.session.activeOrganizationId;
  if (!session || !organizationId) return context.json({ error: "An active organization is required" }, 401);
  return context.json({ subscription: await billing(context.env).getSubscription(organizationId) });
});

app.post("/api/dev/billing", async (context) => {
  if ((context.env.STRIPE_MODE ?? "local") !== "local") return context.notFound();
  const input = await context.req.json<{ action: "activate" | "fail-payment" | "cancel"; organizationId: string; plan?: string }>();
  const local = billing(context.env) as LocalBillingAdapter;
  if (input.action === "activate") await local.activate({ organizationId: input.organizationId, plan: input.plan ?? "starter" });
  else if (input.action === "fail-payment") await local.failPayment({ organizationId: input.organizationId });
  else await local.cancel({ organizationId: input.organizationId });
  return context.json({ subscription: await local.getSubscription(input.organizationId) });
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

export default app;
