import { describe, expect, it, vi } from "vitest";
import { inspectResendSender, senderDomain } from "../src/resend-status.js";

describe("Resend sender reconciliation", () => {
  it("extracts a sender domain and confirms provider verification", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ name: "example.com", status: "verified" }] }))) as unknown as typeof fetch;
    expect(senderDomain("Product <noreply@mail.example.com>")).toBe("mail.example.com");
    expect(await inspectResendSender("re_redacted", "Product <noreply@mail.example.com>", request)).toMatchObject({ domain: "mail.example.com", found: true, verified: true });
  });

  it("reports an unverified provider domain without leaking credentials", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ name: "example.com", status: "pending" }] }))) as unknown as typeof fetch;
    expect(await inspectResendSender("re_redacted", "noreply@example.com", request)).toMatchObject({ found: true, verified: false, providerStatus: "pending" });
  });
});
