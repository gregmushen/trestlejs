import type { ApplicationEnvironment } from "@__TRESTLE_PROJECT_NAME__/authz";
import { PlatformRequestError, type PlatformAudit, type PostgresPlatformRepository } from "@__TRESTLE_PROJECT_NAME__/platform";
import type { Context, Hono } from "hono";
import { z } from "zod";

/**
 * Plans -> Stripe linkage (docs/ADMIN_REQUIRED_CHANGES.md §4.2). Mappings are
 * explicit rows: plan family -> Product, plan version + offer -> Price. They
 * are verified against Stripe when a key is configured (the Price must be
 * recurring, active, and belong to the family's mapped Product) and never
 * inferred from names. Verification stores only what Stripe reported.
 */

type Bindings = { APP_ENV?: ApplicationEnvironment; STRIPE_SECRET_KEY?: string; STRIPE_MODE?: string };
type Authority = { operator: { id: string }; require(permission: string): void; requireSensitive(permission: string, reason: unknown): string };
type Environment = { Bindings: Bindings; Variables: { authority: Authority; correlationId: string } };
type AuditInput = Omit<PlatformAudit, "actorId" | "environment" | "correlationId" | "now">;

export type StripeObject = Readonly<{ id: string; active: boolean; livemode: boolean; product?: string; currency?: string; unitAmount?: number | null; interval?: string | null; name?: string }>;
export type StripeCatalog = {
  /** null when Stripe reports the object does not exist. */
  retrieve(kind: "product" | "price", id: string): Promise<StripeObject | null>;
  createProduct(input: { name: string; plan: string }, idempotencyKey: string): Promise<StripeObject>;
  createPrice(input: { product: string; unitAmount: number; currency: string; interval: "month" | "year"; planVersion: string; offer: string | null }, idempotencyKey: string): Promise<StripeObject>;
};

type Dependencies = {
  repository: (environment: Bindings) => PostgresPlatformRepository;
  audit: (context: Context<Environment>, entry: AuditInput) => PlatformAudit;
  /** "unconfigured" when no Stripe key is available in this environment. */
  stripe: (environment: Bindings) => StripeCatalog | "unconfigured";
};

const reason = z.string().trim().min(1).max(500);
const target = z.object({
  kind: z.enum(["product", "price"]), plan: z.string().trim().min(1).max(40), planVersion: z.number().int().min(1).nullable().optional(),
  offer: z.string().trim().regex(/^[a-z][a-z0-9_]{0,29}$/u, "Offers are short lowercase keys such as monthly or annual").nullable().optional(),
});

async function json<T extends z.ZodType>(context: Context<Environment>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => undefined));
  if (!parsed.success) throw new PlatformRequestError(422, "invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  return parsed.data;
}

/** Form-encoded Stripe REST calls: no SDK in the admin Worker, and the key never leaves this function. */
export function stripeRestCatalog(secretKey: string, fetcher: typeof fetch = fetch): StripeCatalog {
  const call = async (method: "GET" | "POST", path: string, body?: Record<string, string>, idempotencyKey?: string) => {
    const response = await fetcher(`https://api.stripe.com/v1/${path}`, {
      method, headers: { authorization: `Bearer ${secretKey}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      ...(body ? { body: new URLSearchParams(body).toString() } : {}),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new PlatformRequestError(response.status === 400 ? 422 : 409, "provider_rejected", `Stripe returned ${response.status}`);
    return await response.json() as Record<string, any>;
  };
  const object = (body: Record<string, any>): StripeObject => ({
    id: String(body.id), active: body.active !== false, livemode: body.livemode === true, ...(body.product ? { product: String(typeof body.product === "string" ? body.product : body.product.id) } : {}),
    ...(body.currency ? { currency: String(body.currency) } : {}), ...(body.object === "price" ? { unitAmount: body.unit_amount ?? null, interval: body.recurring?.interval ?? null } : {}), ...(body.name ? { name: String(body.name) } : {}),
  });
  return {
    retrieve: async (kind, id) => { const body = await call("GET", `${kind === "product" ? "products" : "prices"}/${encodeURIComponent(id)}`); return body ? object(body) : null; },
    createProduct: async (input, key) => object((await call("POST", "products", { name: input.name, "metadata[trestle_plan]": input.plan }, key))!),
    createPrice: async (input, key) => object((await call("POST", "prices", {
      product: input.product, unit_amount: String(input.unitAmount), currency: input.currency, "recurring[interval]": input.interval, "metadata[trestle_plan_version]": input.planVersion, ...(input.offer ? { "metadata[trestle_offer]": input.offer } : {}),
    }, key))!),
  };
}

export function registerBillingMappingRoutes(admin: Hono<Environment>, dependencies: Dependencies) {
  const environmentOf = (context: Context<Environment>) => context.env.APP_ENV ?? "local";
  const repo = (context: Context<Environment>) => dependencies.repository(context.env);

  /** Checks one mapping against Stripe; the result is stored and shown, never a credential. */
  async function verify(context: Context<Environment>, input: { kind: "product" | "price"; plan: string; externalId: string }): Promise<Record<string, unknown>> {
    const stripe = dependencies.stripe(context.env);
    if (stripe === "unconfigured") return { state: "unverified", reason: "Stripe is not configured in this environment" };
    const found = await stripe.retrieve(input.kind, input.externalId);
    if (!found) return { state: "failed", reason: `Stripe has no ${input.kind} ${input.externalId}` };
    const problems: string[] = [];
    if (!found.active) problems.push(`the ${input.kind} is archived in Stripe`);
    if (found.livemode !== (environmentOf(context) === "production")) problems.push(found.livemode ? "a live-mode object is mapped outside production" : "a test-mode object is mapped in production");
    if (input.kind === "price") {
      if (!found.interval) problems.push("the price is not recurring");
      const [product] = (await repo(context).billingMappings({ environment: environmentOf(context), provider: "stripe", plan: input.plan })).filter((mapping) => mapping.kind === "product");
      if (!product) problems.push(`map ${input.plan} to a Stripe product first`);
      else if (found.product !== product.externalId) problems.push(`the price belongs to ${found.product}, not ${product.externalId}`);
    }
    return { state: problems.length ? "failed" : "verified", ...(problems.length ? { reason: problems.join("; ") } : {}), livemode: found.livemode, active: found.active,
      ...(found.currency ? { currency: found.currency } : {}), ...(found.unitAmount !== undefined ? { unitAmount: found.unitAmount } : {}), ...(found.interval ? { interval: found.interval } : {}), ...(found.product ? { product: found.product } : {}) };
  }

  async function checkTarget(context: Context<Environment>, input: z.infer<typeof target>) {
    const versions = (await repo(context).planVersions()).filter((version) => version.plan === input.plan);
    if (!versions.length) throw new PlatformRequestError(404, "not_found", `No plan ${input.plan}`);
    if (input.kind === "product" && (input.planVersion || input.offer)) throw new PlatformRequestError(422, "invalid", "Products map to the plan family; versions and offers map to prices");
    if (input.kind === "price" && !input.planVersion) throw new PlatformRequestError(422, "invalid", "A price maps to one plan version");
    if (input.kind === "price" && !versions.some((version) => version.version === input.planVersion)) throw new PlatformRequestError(404, "not_found", `No version ${input.plan}@${input.planVersion}`);
    const existing = await repo(context).billingMappings({ environment: environmentOf(context), provider: "stripe", plan: input.plan });
    if (existing.some((mapping) => mapping.kind === input.kind && mapping.planVersion === (input.planVersion ?? null) && mapping.offer === (input.offer ?? null))) throw new PlatformRequestError(409, "conflict", "That target is already mapped; disconnect it first");
  }

  admin.get("/api/admin/billing-mappings", async (context) => {
    context.get("authority").require("platform.plans.read");
    const plan = context.req.query("plan");
    return context.json({ environment: environmentOf(context), stripe: dependencies.stripe(context.env) === "unconfigured" ? "unconfigured" : "configured", mappings: await repo(context).billingMappings({ environment: environmentOf(context), provider: "stripe", ...(plan ? { plan } : {}) }) });
  });

  admin.post("/api/admin/billing-mappings", async (context) => {
    const input = await json(context, target.extend({ externalId: z.string().trim().regex(/^(prod|price)_[A-Za-z0-9]{3,}$/u, "Use a Stripe product (prod_…) or price (price_…) ID"), reason }).strict());
    const why = context.get("authority").requireSensitive("platform.plans.manage", input.reason);
    if (!input.externalId.startsWith(input.kind === "product" ? "prod_" : "price_")) throw new PlatformRequestError(422, "invalid", `A ${input.kind} mapping needs a ${input.kind === "product" ? "prod_" : "price_"} ID`);
    await checkTarget(context, input);
    if ((await repo(context).billingMappings({ environment: environmentOf(context), provider: "stripe" })).some((mapping) => mapping.externalId === input.externalId)) throw new PlatformRequestError(409, "conflict", `${input.externalId} is already mapped`);
    const verification = await verify(context, { kind: input.kind, plan: input.plan, externalId: input.externalId });
    if (verification.state === "failed") throw new PlatformRequestError(422, "verification_failed", String(verification.reason));
    const mapping = { environment: environmentOf(context), provider: "stripe", kind: input.kind, plan: input.plan, planVersion: input.planVersion ?? null, offer: input.offer ?? null, externalId: input.externalId, verification };
    await repo(context).mutate(repo(context).insertBillingMapping(mapping, context.get("authority").operator.id), dependencies.audit(context, { name: "commercial.billing_mapping.connected", organizationId: null, targetType: "billing_mapping", targetId: `${input.plan}${input.planVersion ? `@${input.planVersion}` : ""}${input.offer ? `:${input.offer}` : ""}`, reason: why, summary: { kind: input.kind, externalId: input.externalId, verification: verification.state } }));
    return context.json({ verification }, 201);
  });

  /** Creates the Product or Price in Stripe, then maps it, so the operator never copies IDs by hand. */
  admin.post("/api/admin/billing-mappings/create", async (context) => {
    const input = await json(context, target.extend({ unitAmount: z.number().int().min(0).max(100_000_000).optional(), currency: z.string().regex(/^[a-z]{3}$/u).optional(), interval: z.enum(["month", "year"]).optional(), reason }).strict());
    const authority = context.get("authority");
    const why = authority.requireSensitive("platform.plans.manage", input.reason);
    const stripe = dependencies.stripe(context.env);
    if (stripe === "unconfigured") throw new PlatformRequestError(409, "provider_unconfigured", "Stripe is not configured in this environment; connect existing IDs instead");
    await checkTarget(context, input);
    const key = `trestle:${environmentOf(context)}:${input.kind}:${input.plan}:${input.planVersion ?? 0}:${input.offer ?? ""}:${context.get("correlationId")}`;
    let created: StripeObject;
    if (input.kind === "product") {
      const version = (await repo(context).planVersions()).filter((entry) => entry.plan === input.plan).at(-1)!;
      created = await stripe.createProduct({ name: version.name, plan: input.plan }, key);
    } else {
      const [product] = (await repo(context).billingMappings({ environment: environmentOf(context), provider: "stripe", plan: input.plan })).filter((mapping) => mapping.kind === "product");
      if (!product) throw new PlatformRequestError(409, "conflict", `Map ${input.plan} to a Stripe product first`);
      if (input.unitAmount === undefined || !input.currency || !input.interval) throw new PlatformRequestError(422, "invalid", "A new price needs an amount, currency, and interval");
      created = await stripe.createPrice({ product: product.externalId, unitAmount: input.unitAmount, currency: input.currency, interval: input.interval, planVersion: `${input.plan}@${input.planVersion}`, offer: input.offer ?? null }, key);
    }
    const verification = await verify(context, { kind: input.kind, plan: input.plan, externalId: created.id });
    await repo(context).mutate(repo(context).insertBillingMapping({ environment: environmentOf(context), provider: "stripe", kind: input.kind, plan: input.plan, planVersion: input.planVersion ?? null, offer: input.offer ?? null, externalId: created.id, verification }, authority.operator.id),
      dependencies.audit(context, { name: "commercial.billing_mapping.created", organizationId: null, targetType: "billing_mapping", targetId: `${input.plan}${input.planVersion ? `@${input.planVersion}` : ""}${input.offer ? `:${input.offer}` : ""}`, reason: why, summary: { kind: input.kind, externalId: created.id } }));
    return context.json({ externalId: created.id, verification }, 201);
  });

  admin.post("/api/admin/billing-mappings/:id/verify", async (context) => {
    context.get("authority").require("platform.plans.manage");
    const [mapping] = await repo(context).billingMappings({ environment: environmentOf(context), id: context.req.param("id") });
    if (!mapping) throw new PlatformRequestError(404, "not_found", "Mapping not found");
    const verification = await verify(context, mapping);
    await repo(context).mutate(repo(context).recordBillingMappingVerification(mapping.id, verification), dependencies.audit(context, { name: "commercial.billing_mapping.verified", organizationId: null, targetType: "billing_mapping", targetId: mapping.id, reason: "verification", summary: { state: verification.state } }));
    return context.json({ verification });
  });

  admin.delete("/api/admin/billing-mappings/:id", async (context) => {
    const input = await json(context, z.object({ reason }).strict());
    const why = context.get("authority").requireSensitive("platform.plans.manage", input.reason);
    const [mapping] = await repo(context).billingMappings({ environment: environmentOf(context), id: context.req.param("id") });
    if (!mapping) throw new PlatformRequestError(404, "not_found", "Mapping not found");
    await repo(context).mutate(repo(context).deleteBillingMapping(mapping.id), dependencies.audit(context, { name: "commercial.billing_mapping.disconnected", organizationId: null, targetType: "billing_mapping", targetId: mapping.id, reason: why, summary: { kind: mapping.kind, plan: mapping.plan, planVersion: mapping.planVersion, offer: mapping.offer, externalId: mapping.externalId } }));
    return context.body(null, 204);
  });
}
