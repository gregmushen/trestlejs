import { describe, expect, it } from "vitest";

const enabled = process.env.TRESTLE_PROVIDER_INTEGRATION_TESTS === "1";
const provider = enabled ? describe : describe.skip;

provider("protected staging providers", () => {
  it("authenticates to Resend and enforces a staging recipient redirect", async () => {
    const key = process.env.RESEND_API_KEY;
    const redirect = process.env.EMAIL_STAGING_REDIRECT;
    expect(key?.startsWith("re_")).toBe(true);
    expect(redirect).toMatch(/^[^@\s]+@[^@\s]+$/u);
    const response = await fetch("https://api.resend.com/domains", { headers: { authorization: `Bearer ${key}` } });
    expect(response.ok, `Resend returned HTTP ${response.status}`).toBe(true);
  });

  it("authenticates to Stripe test mode without creating resources", async () => {
    const key = process.env.STRIPE_SECRET_KEY;
    expect(key?.startsWith("sk_test_")).toBe(true);
    const response = await fetch("https://api.stripe.com/v1/account", { headers: { authorization: `Bearer ${key}` } });
    expect(response.ok, `Stripe returned HTTP ${response.status}`).toBe(true);
    const account = await response.json() as { id?: string };
    expect(account.id).toMatch(/^acct_/u);
  });
});
