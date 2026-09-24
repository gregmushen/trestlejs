import { getPlan, planEntitlements, plans, PostgresBillingProjectionRepository } from "@__TRESTLE_PROJECT_NAME__/billing";
import { LocalBillingAdapter, StripeBillingAdapter, type BillingService } from "@__TRESTLE_PROJECT_NAME__/integrations";
import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";

export type AppServices = Readonly<{ billing: BillingService }>;

export function stripeConfigurationReady(environment: AuthEnvironment): boolean {
  const appEnvironment = environment.APP_ENV ?? "local";
  if (appEnvironment === "local") return (environment.STRIPE_MODE ?? "local") === "local";
  const mode = appEnvironment === "production" ? "live" : "test";
  if (environment.STRIPE_MODE !== mode || !environment.STRIPE_SECRET_KEY
    || !new RegExp(`^sk_${mode}_[A-Za-z0-9_]+$`, "u").test(environment.STRIPE_SECRET_KEY)
    || !environment.STRIPE_WEBHOOK_SECRET || !/^whsec_[A-Za-z0-9_]+$/u.test(environment.STRIPE_WEBHOOK_SECRET)
    || !environment.STRIPE_PUBLISHABLE_KEY || !new RegExp(`^pk_${mode}_[A-Za-z0-9_]+$`, "u").test(environment.STRIPE_PUBLISHABLE_KEY)) return false;
  try {
    const url = new URL(environment.BILLING_RETURN_URL ?? "");
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) return false;
    const prices: unknown = JSON.parse(environment.STRIPE_PRICES ?? "");
    if (!prices || typeof prices !== "object" || Array.isArray(prices)) return false;
    const mapping = prices as Record<string, unknown>;
    const declared = Object.keys(plans);
    if (Object.keys(mapping).length !== declared.length) return false;
    const ids = declared.map((plan) => mapping[plan]);
    return ids.every((id) => typeof id === "string" && /^price_[A-Za-z0-9_]+$/u.test(id))
      && new Set(ids).size === ids.length;
  } catch { return false; }
}

export function createBillingService(environment: AuthEnvironment): BillingService {
  const repository = new PostgresBillingProjectionRepository(environment.DATABASE_URL, environment.DATABASE_DRIVER);
  if ((environment.STRIPE_MODE ?? "local") === "local") {
    return new LocalBillingAdapter(repository, planEntitlements, Object.fromEntries(Object.entries(plans).map(([name, plan]) => [name, plan.version])));
  }
  let prices: Record<string, string> = {};
  try { prices = JSON.parse(environment.STRIPE_PRICES ?? "{}"); } catch { throw new Error("STRIPE_PRICES must be a JSON object"); }
  for (const plan of Object.keys(prices)) if (!getPlan(plan)) throw new Error(`STRIPE_PRICES contains unknown plan ${plan}`);
  return new StripeBillingAdapter({ secretKey: environment.STRIPE_SECRET_KEY ?? "", prices, returnUrl: environment.BILLING_RETURN_URL ?? `${environment.WEB_ORIGIN ?? "http://localhost:42069"}/settings/billing`, repository });
}

export function createServices(environment: AuthEnvironment): AppServices {
  return { billing: createBillingService(environment) };
}
