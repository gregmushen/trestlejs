import { AccessDeniedError } from "@__TRESTLE_PROJECT_NAME__/context";
import { BillingProviderUnavailable, BillingRateLimited, BillingValidationError } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { describe, expect, it } from "vitest";
import { mapHttpError } from "./http-errors.js";

describe("HTTP error normalization", () => {
  it("keeps provider classes out of the response contract", () => {
    expect(mapHttpError(new BillingValidationError("bad plan"))).toMatchObject({ status: 400, code: "billing_validation", retryable: false });
    expect(mapHttpError(new BillingRateLimited("provider detail"))).toMatchObject({ status: 429, code: "billing_rate_limited", retryable: true });
    expect(mapHttpError(new BillingProviderUnavailable("provider detail"))).toMatchObject({ status: 503, code: "billing_provider_unavailable", message: "Billing provider is unavailable" });
  });

  it("does not expose permission or entitlement details", () => {
    const error = new AccessDeniedError({ allowed: false, missing: ["permission", "entitlement"] });
    expect(mapHttpError(error)).toMatchObject({ status: 403, code: "access_denied", message: "The requested operation is not permitted" });
  });
});
