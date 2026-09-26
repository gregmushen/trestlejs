import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { localBillingLookup, PostgresLocalBillingProvider, reconcileBillingSubscription, type BillingReconciliationRun, type BillingSubscriptionLookup } from "@__TRESTLE_PROJECT_NAME__/billing";
import type { BillingReconciliationRequest } from "@__TRESTLE_PROJECT_NAME__/db";
import { BillingConfigurationError, retrieveCurrentStripeSubscription } from "@__TRESTLE_PROJECT_NAME__/integrations";

import type { EventHandler } from "./async-runtime.js";

/** Local mode (including signed local fixtures) reads the local provider;
 * Stripe test/live mode retrieves the current Stripe subscription. */
export function billingSubscriptionLookup(environment: AuthEnvironment): BillingSubscriptionLookup {
  if ((environment.STRIPE_MODE ?? "local") === "local") {
    return localBillingLookup(new PostgresLocalBillingProvider(environment.DATABASE_URL, environment.DATABASE_DRIVER));
  }
  const secretKey = environment.STRIPE_SECRET_KEY;
  if (!secretKey) throw new BillingConfigurationError("Stripe reconciliation is not configured");
  return async (request) => {
    if (request.provider !== "stripe") throw new BillingConfigurationError("No billing lookup is configured for this provider");
    return await retrieveCurrentStripeSubscription({ secretKey, event: { id: request.providerEventId, type: request.type,
      providerSubscriptionId: request.providerSubscriptionId, occurredAt: request.occurredAt } });
  };
}

export async function runBillingReconciliation(environment: AuthEnvironment, request: { provider: string; providerSubscriptionId: string }): Promise<BillingReconciliationRun> {
  return await reconcileBillingSubscription({ databaseUrl: environment.DATABASE_URL, ...(environment.DATABASE_DRIVER ? { driver: environment.DATABASE_DRIVER } : {}),
    provider: request.provider, providerSubscriptionId: request.providerSubscriptionId, lookup: billingSubscriptionLookup(environment) });
}

/**
 * Background reconciliation of a committed request. Register it with
 * `{ authority: "system" }`: the request carries no tenant, and the tenant is
 * decided from current provider state and the immutable ownership binding.
 * Work that is still leased elsewhere or still due is retried, never
 * acknowledged, so an abandoned lease is recovered after it expires.
 */
export const handleBillingReconciliationRequested: EventHandler<BillingReconciliationRequest, AuthEnvironment> = async (request, _envelope, environment, context) => {
  const run = await runBillingReconciliation(environment, request);
  const fields = { provider: request.provider, providerEventId: request.providerEventId, state: run.state, outcomes: run.outcomes.join(",") };
  if (run.outcomes.some((outcome) => outcome === "not_found" || outcome === "unmapped" || outcome === "ownership_conflict")) context.log.error("billing.reconciliation.rejected", fields);
  else context.log.info("billing.reconciliation.completed", fields);
  if (run.state === "busy" || run.state === "due") throw new Error("Billing reconciliation is still due");
};
