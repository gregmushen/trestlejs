import { describe, expect, it } from "vitest";

import { applicationEventCatalog } from "./application-catalog.js";

const payload = { organizationId: "org-1", plan: "pro", planVersion: 1, status: "active",
  entitlements: ["article.basic"], cancelAtPeriodEnd: false };

describe("internal billing events", () => {
  it("registers normalized subscription transitions without exposing public webhooks", () => {
    for (const name of ["activated", "updated", "cancelled", "past_due"]) {
      const event = `billing.subscription.${name}`;
      expect(applicationEventCatalog.has(event, 1)).toBe(true);
      expect(applicationEventCatalog.resource(event, 1, payload)).toEqual({ type: "organization", id: "org-1" });
      expect(applicationEventCatalog.project(event, 1, payload)).toBeNull();
    }
    expect(applicationEventCatalog.publicEvents().filter((event) => event.type.startsWith("billing."))).toEqual([]);
  });

  it("rejects malformed tenant and entitlement payloads", () => {
    expect(() => applicationEventCatalog.parse("billing.subscription.activated", 1, { ...payload, organizationId: "" }))
      .toThrow("Internal event payload fails its schema");
    expect(() => applicationEventCatalog.parse("billing.subscription.updated", 1, { ...payload, entitlements: [""] }))
      .toThrow("Internal event payload fails its schema");
  });

  it("keeps Checkout and invoice notifications private and provider-neutral", () => {
    const checkout = { organizationId: "org-1", currentSubscription: true, paymentStatus: "paid" };
    expect(applicationEventCatalog.parse("billing.checkout.completed", 1, checkout)).toEqual(checkout);
    expect(applicationEventCatalog.project("billing.checkout.completed", 1, checkout)).toBeNull();
    for (const name of ["billing.invoice.paid", "billing.invoice.payment_failed"]) {
      const invoice = { organizationId: "org-1", currentSubscription: false, amountMinor: 2500, currency: "usd" };
      expect(applicationEventCatalog.resource(name, 1, invoice)).toEqual({ type: "organization", id: "org-1" });
      expect(applicationEventCatalog.project(name, 1, invoice)).toBeNull();
      expect(() => applicationEventCatalog.parse(name, 1, { ...invoice, currency: "invalid" }))
        .toThrow("Internal event payload fails its schema");
    }
    expect(applicationEventCatalog.publicEvents().filter((event) => event.type.startsWith("billing."))).toEqual([]);
  });
});
