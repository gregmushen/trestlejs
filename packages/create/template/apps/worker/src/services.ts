import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { planEntitlements, PostgresBillingProjectionRepository } from "@__TRESTLE_PROJECT_NAME__/billing";
import { loadCheckoutPrices } from "@__TRESTLE_PROJECT_NAME__/data";
import { applicationConnectionString, createSqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";
import { LocalBillingAdapter, StripeBillingAdapter, type BillingService } from "@__TRESTLE_PROJECT_NAME__/integrations";

/** Services resolve lazily: a request that never touches billing never reads price mappings. */
export type AppServices = Readonly<{ billing(): Promise<BillingService> }>;

/** Restricted application-role runner for the narrow price-mapping SECURITY DEFINER reads. */
export const mappingRunner = (environment: AuthEnvironment) => createSqlRunner(applicationConnectionString(environment.DATABASE_URL), environment.DATABASE_DRIVER);

export async function createBillingService(environment: AuthEnvironment): Promise<BillingService> {
  const repository = new PostgresBillingProjectionRepository(environment.DATABASE_URL, environment.DATABASE_DRIVER);
  if ((environment.STRIPE_MODE ?? "local") === "local") return new LocalBillingAdapter(repository, planEntitlements);
  let configured: Record<string, string> = {};
  try { configured = JSON.parse(environment.STRIPE_PRICES ?? "{}"); } catch { throw new Error("STRIPE_PRICES must be a JSON object"); }
  for (const plan of Object.keys(configured)) if (!(plan in planEntitlements)) throw new Error(`STRIPE_PRICES contains unknown plan ${plan}`);
  // Price mappings made in the admin win over the STRIPE_PRICES bootstrap configuration.
  const prices = { ...configured, ...await loadCheckoutPrices(mappingRunner(environment), environment.APP_ENV ?? "local") };
  return new StripeBillingAdapter({ secretKey: environment.STRIPE_SECRET_KEY ?? "", prices, returnUrl: environment.BILLING_RETURN_URL ?? `${environment.WEB_ORIGIN ?? "http://localhost:42069"}/settings/billing`, repository });
}

export function createServices(environment: AuthEnvironment): AppServices {
  let billing: Promise<BillingService> | undefined;
  return { billing: () => (billing ??= createBillingService(environment)) };
}
