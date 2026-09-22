import { AccessDeniedError } from "@__TRESTLE_PROJECT_NAME__/context";
import { BillingAlreadyCancelled, BillingConfigurationError, BillingPlanUnavailable, BillingProviderUnavailable, BillingRateLimited, BillingSubscriptionNotFound, BillingValidationError } from "@__TRESTLE_PROJECT_NAME__/integrations";

export type HttpError = Readonly<{ status: 400 | 403 | 404 | 409 | 429 | 500 | 503; code: string; message: string; retryable: boolean }>;

export function mapHttpError(error: unknown): HttpError {
  if (error instanceof AccessDeniedError) return { status: 403, code: "access_denied", message: "The requested operation is not permitted", retryable: false };
  if (error instanceof BillingValidationError) return { status: 400, code: "billing_validation", message: error.message, retryable: false };
  if (error instanceof BillingPlanUnavailable) return { status: 400, code: "billing_plan_unavailable", message: error.message, retryable: false };
  if (error instanceof BillingSubscriptionNotFound) return { status: 404, code: "billing_subscription_not_found", message: error.message, retryable: false };
  if (error instanceof BillingAlreadyCancelled) return { status: 409, code: "billing_already_cancelled", message: error.message, retryable: false };
  if (error instanceof BillingRateLimited) return { status: 429, code: "billing_rate_limited", message: "Billing provider rate limit reached", retryable: true };
  if (error instanceof BillingProviderUnavailable) return { status: 503, code: "billing_provider_unavailable", message: "Billing provider is unavailable", retryable: true };
  if (error instanceof BillingConfigurationError) return { status: 500, code: "billing_configuration", message: "Billing is not configured", retryable: false };
  return { status: 500, code: "internal_error", message: "An unexpected error occurred", retryable: false };
}
