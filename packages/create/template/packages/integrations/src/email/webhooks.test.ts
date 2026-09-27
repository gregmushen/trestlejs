import { describe, expect, it } from "vitest";
import { normalizeVerifiedResendEvent, verifiedResendDeliveryContext } from "./webhooks.js";

describe("verified Resend event normalization", () => {
  const valid = { type: "email.delivered", created_at: "2026-09-23T00:00:00.000Z", data: { email_id: "email_1" } };

  it("normalizes a signed delivery payload without recipient or message content", () => {
    expect(normalizeVerifiedResendEvent({ ...valid, data: { ...valid.data, to: ["private@example.test"] } }, "msg_1"))
      .toEqual({ id: "msg_1", emailDeliveryId: "email_1", occurredAt: new Date(valid.created_at), status: "delivered" });
  });

  it("reads the organization tag, single recipient and bounce type apart from the delivery record", () => {
    const bounced = { type: "email.bounced", created_at: valid.created_at, data: { email_id: "email_1", to: ["Private@Example.test"],
      bounce: { type: "Permanent", subType: "Suppressed", message: "hard bounce" }, tags: { trestle_organization: "org_1", category: "welcome" } } };
    expect(normalizeVerifiedResendEvent(bounced, "msg_1").status).toBe("bounced");
    expect(verifiedResendDeliveryContext(bounced)).toEqual({ organizationId: "org_1", recipient: "Private@Example.test", bounceType: "Permanent", bounceSubType: "Suppressed" });
    expect(normalizeVerifiedResendEvent({ ...valid, type: "email.delivery_delayed" }, "msg_2").status).toBe("delivery_delayed");
  });

  it("ignores unexpected context shapes instead of rejecting a signed event", () => {
    const odd = { ...valid, data: { email_id: "email_1", to: ["a@example.test", "b@example.test"], tags: [{ name: "trestle_organization", value: "org_1" }], bounce: "x" } };
    expect(verifiedResendDeliveryContext(odd)).toEqual({});
    expect(verifiedResendDeliveryContext({ ...valid, data: { email_id: "email_1", tags: { trestle_organization: "org 1; drop" } } })).toEqual({});
  });

  it("rejects malformed timestamps and delivery identifiers before persistence", () => {
    expect(() => normalizeVerifiedResendEvent({ ...valid, created_at: "not-a-date" }, "msg_1")).toThrow();
    expect(() => normalizeVerifiedResendEvent({ ...valid, data: { email_id: "" } }, "msg_1")).toThrow();
  });
});
