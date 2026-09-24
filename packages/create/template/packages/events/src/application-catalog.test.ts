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
});
