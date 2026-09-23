import { AccessDeniedError, type AccessDecision } from "@__TRESTLE_PROJECT_NAME__/authz";
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
    const decision: AccessDecision = { allowed: false, reason: "entitlement_missing", principal: { type: "user", id: "user-1" }, entitlement: { code: "workflows.advanced", enabled: false }, permission: { code: "workflows.publish", plane: "application", granted: true, grantedBy: ["editor"] }, assignments: { organization: [], application: ["editor"], platform: [] }, constraints: [] };
    const mapped = mapHttpError(new AccessDeniedError(decision));
    expect(mapped).toMatchObject({ status: 403, code: "access_denied", message: "The requested operation is not permitted" });
    expect(JSON.stringify(mapped)).not.toMatch(/workflows|editor/u);
  });
});
