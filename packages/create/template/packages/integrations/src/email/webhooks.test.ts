import { describe, expect, it } from "vitest";
import { normalizeVerifiedResendEvent } from "./webhooks.js";

describe("verified Resend event normalization", () => {
  const valid = { type: "email.delivered", created_at: "2026-09-23T00:00:00.000Z", data: { email_id: "email_1" } };

  it("normalizes a signed delivery payload without recipient or message content", () => {
    expect(normalizeVerifiedResendEvent({ ...valid, data: { ...valid.data, to: ["private@example.test"] } }, "msg_1"))
      .toEqual({ id: "msg_1", emailDeliveryId: "email_1", occurredAt: new Date(valid.created_at), status: "delivered" });
  });

  it("rejects malformed timestamps and delivery identifiers before persistence", () => {
    expect(() => normalizeVerifiedResendEvent({ ...valid, created_at: "not-a-date" }, "msg_1")).toThrow();
    expect(() => normalizeVerifiedResendEvent({ ...valid, data: { email_id: "" } }, "msg_1")).toThrow();
  });
});
