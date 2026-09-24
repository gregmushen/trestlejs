import type { StripeCatalog } from "./stripe-sync.js";

export type StripeDeploymentEnvironment = "preview" | "staging" | "production";
export type StripeDeploymentConfiguration = Readonly<{
  mode: string | undefined;
  publishableKey: string | undefined;
  prices: string | undefined;
  returnUrl: string | undefined;
}>;

/** Stripe restricted server keys are valid when scoped to the operations used by this adapter. */
export function stripeServerKeyMatchesMode(key: string | undefined, environment: StripeDeploymentEnvironment): boolean {
  const mode = environment === "production" ? "live" : "test";
  return Boolean(key && new RegExp(`^(?:sk|rk)_${mode}_[A-Za-z0-9_]+$`, "u").test(key));
}

/** Read-only, provider-neutral diagnostics. Never include credential values in issues. */
export function stripeDeploymentIssues(environment: StripeDeploymentEnvironment, configuration: StripeDeploymentConfiguration, catalog: StripeCatalog): string[] {
  const issues: string[] = [];
  const mode = environment === "production" ? "live" : "test";
  if (configuration.mode !== mode) issues.push(`STRIPE_MODE must be ${mode}`);
  if (!configuration.publishableKey || !new RegExp(`^pk_${mode}_[A-Za-z0-9_]+$`, "u").test(configuration.publishableKey)) {
    issues.push(`STRIPE_PUBLISHABLE_KEY must be a ${mode}-mode publishable key`);
  }
  let prices: unknown;
  try { prices = JSON.parse(configuration.prices ?? ""); }
  catch { prices = null; }
  if (!prices || typeof prices !== "object" || Array.isArray(prices)) {
    issues.push("STRIPE_PRICES must be a JSON object with one price ID per declared plan");
  } else {
    const mapping = prices as Record<string, unknown>;
    const declared = Object.keys(catalog.plans);
    for (const plan of declared) {
      if (typeof mapping[plan] !== "string" || !/^price_[A-Za-z0-9_]+$/u.test(mapping[plan])) {
        issues.push(`STRIPE_PRICES is missing a valid price ID for ${plan}`);
      }
    }
    for (const plan of Object.keys(mapping)) if (!declared.includes(plan)) issues.push(`STRIPE_PRICES contains undeclared plan ${plan}`);
    const ids = Object.values(mapping).filter((value): value is string => typeof value === "string");
    if (new Set(ids).size !== ids.length) issues.push("STRIPE_PRICES maps multiple plans to one price ID");
  }
  try {
    const url = new URL(configuration.returnUrl ?? "");
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) throw new Error("invalid");
  } catch { issues.push("BILLING_RETURN_URL must be a complete HTTPS URL without credentials or a fragment"); }
  return issues;
}
