import { describe, expect, it, vi } from "vitest";

const stripe = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: "cs_test_1", url: "https://checkout.stripe.test/session", expires_at: 1_790_000_000 })),
}));

vi.mock("stripe", () => ({ default: class {
  checkout = { sessions: { create: stripe.create } };
} }));

import { StripeBillingAdapter } from "./stripe.js";

describe("Stripe checkout metadata", () => {
  it("puts tenant and plan identity on both the session and underlying subscription", async () => {
    const adapter = new StripeBillingAdapter({
      secretKey: "sk_test_placeholder",
      prices: { pro: "price_test_pro" },
      returnUrl: "https://app.example.test/settings/billing",
      repository: { get: async () => null, put: async () => undefined },
    });
    const session = await adapter.createCheckoutSession({ organizationId: "org-1", plan: "pro", requestId: "request-1" });
    expect(session).toMatchObject({ id: "cs_test_1", url: "https://checkout.stripe.test/session" });
    expect(stripe.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: "subscription",
      metadata: { organizationId: "org-1", plan: "pro" },
      subscription_data: { metadata: { organizationId: "org-1", plan: "pro" } },
    }), { idempotencyKey: "checkout:org-1:pro:request-1" });
  });
});
