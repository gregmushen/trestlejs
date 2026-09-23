import { describe, expect, it } from "vitest";

import { readStagingProviderVariables } from "./provider-staging-config.js";

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
    expect(key?.startsWith("sk_test_")).toBe(true);
    expect(staging.STRIPE_MODE).toBe("test");
    expect(staging.STRIPE_PUBLISHABLE_KEY?.startsWith("pk_test_")).toBe(true);
    const response = await fetch("https://api.stripe.com/v1/account", { headers: { authorization: `Bearer ${key}` } });
    expect(response.ok, `Stripe returned HTTP ${response.status}`).toBe(true);
    const account = await response.json() as { id?: string };
    expect(account.id).toMatch(/^acct_/u);
  });
});
