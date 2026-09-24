import { describe, expect, it } from "vitest";

import { readStagingProviderVariables } from "./provider-staging-config.js";
import { StripeBillingAdapter } from "./payments/adapters/stripe.js";

const enabled = process.env.TRESTLE_PROVIDER_INTEGRATION_TESTS === "1";
const provider = enabled ? describe : describe.skip;

provider("protected staging providers", () => {
  it("authenticates to Resend with the declared staging recipient redirect", async () => {
    const key = process.env.RESEND_API_KEY;
    const staging = await readStagingProviderVariables();
    const redirect = staging.EMAIL_STAGING_REDIRECT;
    expect(key?.startsWith("re_")).toBe(true);
    expect(staging.EMAIL_DELIVERY_MODE).toBe("resend");
    expect(staging.EMAIL_FROM).not.toBe("CHANGE_ME");
    expect(redirect).toMatch(/^[^@\s]+@[^@\s]+$/u);
    const response = await fetch("https://api.resend.com/domains", { headers: { authorization: `Bearer ${key}` } });
    expect(response.ok, `Resend returned HTTP ${response.status}`).toBe(true);
  });

  it("authenticates to Stripe test mode without creating resources", async () => {
    const key = process.env.STRIPE_SECRET_KEY;
    const staging = await readStagingProviderVariables();
    expect(key).toMatch(/^(?:sk|rk)_test_[A-Za-z0-9_]+$/u);
    expect(staging.STRIPE_MODE).toBe("test");
    expect(staging.STRIPE_PUBLISHABLE_KEY?.startsWith("pk_test_")).toBe(true);
    for (const resource of ["prices", "products", "subscriptions", "checkout/sessions"]) {
      const response = await fetch(`https://api.stripe.com/v1/${resource}?limit=1`, { headers: { authorization: `Bearer ${key}` } });
      expect(response.ok, `Stripe ${resource} returned HTTP ${response.status}`).toBe(true);
      const result = await response.json() as { object?: string; data?: unknown };
      expect(result.object).toBe("list");
      expect(Array.isArray(result.data)).toBe(true);
    }
  });

  it("creates one test-mode Checkout session across an idempotent retry", async () => {
    const key = process.env.STRIPE_SECRET_KEY;
    const staging = await readStagingProviderVariables();
    expect(key).toMatch(/^(?:sk|rk)_test_[A-Za-z0-9_]+$/u);
    expect(staging.STRIPE_MODE).toBe("test");
    const prices = JSON.parse(staging.STRIPE_PRICES ?? "{}") as Record<string, string>;
    expect(prices.starter).toMatch(/^price_[A-Za-z0-9]+$/u);
    expect(staging.BILLING_RETURN_URL).toMatch(/^https:\/\//u);
    const adapter = new StripeBillingAdapter({
      secretKey: key!, prices, returnUrl: staging.BILLING_RETURN_URL!,
      repository: { get: async () => null, put: async () => undefined },
    });
    const input = { organizationId: `provider-gate-${crypto.randomUUID()}`, plan: "starter", requestId: crypto.randomUUID() };
    const first = await adapter.createCheckoutSession(input);
    const retry = await adapter.createCheckoutSession(input);
    expect(first.id).toMatch(/^cs_test_/u);
    expect(first.url).toMatch(/^https:\/\/checkout\.stripe\.com\//u);
    expect(retry.id).toBe(first.id);
  });
});
