import { getPlan, planEntitlements, plans, PostgresBillingProjectionRepository } from "@__TRESTLE_PROJECT_NAME__/billing";
import { LocalBillingAdapter, StripeBillingAdapter, type BillingService } from "@__TRESTLE_PROJECT_NAME__/integrations";
import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";

export type AppServices = Readonly<{ billing: BillingService }>;

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
