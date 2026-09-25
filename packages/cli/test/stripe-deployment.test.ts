import { describe, expect, it } from "vitest";

import { stripeDeploymentIssues, stripeServerKeyMatchesMode } from "../src/stripe-deployment.js";
import { validateStripeCatalog } from "../src/stripe-sync.js";

const catalog = validateStripeCatalog({ schemaVersion: 1, currency: "usd", plans: {
  starter: { version: 1, name: "Starter", unitAmount: 1900, interval: "month" },
  pro: { version: 1, name: "Pro", unitAmount: 4900, interval: "month" },
} });
const ready = { mode: "test", publishableKey: "pk_test_fixture", prices: JSON.stringify({ starter: "price_starter", pro: "price_pro" }),
  returnUrl: "https://app.example.test/settings/billing" };

describe("Stripe deployment configuration", () => {
  it("accepts full and restricted server keys only in their own mode", () => {
    expect(stripeServerKeyMatchesMode("sk_test_fixture", "staging")).toBe(true);
    expect(stripeServerKeyMatchesMode("rk_test_fixture", "preview")).toBe(true);
    expect(stripeServerKeyMatchesMode("rk_live_fixture", "production")).toBe(true);
    expect(stripeServerKeyMatchesMode("rk_live_fixture", "staging")).toBe(false);
    expect(stripeServerKeyMatchesMode("pk_test_fixture", "staging")).toBe(false);
    expect(stripeServerKeyMatchesMode("rk_test_", "staging")).toBe(false);
  });
  it("accepts a complete test-mode mapping without exposing values", () => {
    expect(stripeDeploymentIssues("preview", ready, catalog)).toEqual([]);
    expect(stripeDeploymentIssues("staging", ready, catalog)).toEqual([]);
  });

  it("rejects empty, partial, duplicated, malformed, and unknown price maps", () => {
    for (const prices of ["{}", "garbage", "[]", JSON.stringify({ pro: "price_pro" }),
      JSON.stringify({ starter: "price_same", pro: "price_same" }),
      JSON.stringify({ starter: "price_starter", pro: "bad" }),
      JSON.stringify({ starter: "price_starter", pro: "price_pro", hidden: "price_hidden" })]) {
      const issues = stripeDeploymentIssues("staging", { ...ready, prices }, catalog);
      expect(issues.some((issue) => issue.includes("STRIPE_PRICES"))).toBe(true);
      expect(issues.join(" ")).not.toContain("price_starter");
    }
  });

  it("requires live-mode credentials and a safe HTTPS return URL in production", () => {
    const issues = stripeDeploymentIssues("production", { ...ready, returnUrl: "https://user:pass@example.test/#token" }, catalog);
    expect(issues).toContain("STRIPE_MODE must be live");
    expect(issues).toContain("STRIPE_PUBLISHABLE_KEY must be a live-mode publishable key");
    expect(issues).toContain("BILLING_RETURN_URL must be a complete HTTPS URL without credentials or a fragment");
    expect(stripeDeploymentIssues("production", { ...ready, mode: "live", publishableKey: "pk_live_fixture" }, catalog)).toEqual([]);
  });
});
