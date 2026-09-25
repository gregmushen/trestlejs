import { describe, expect, it, vi } from "vitest";
import { emailDeploymentIssues, inspectResendSender, senderDomain } from "../src/resend-status.js";

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

  it("does not accept a valid key from an account without the configured sender domain", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ name: "other.example", status: "verified" }] }))) as unknown as typeof fetch;
    expect(await inspectResendSender("re_redacted", "Paper Route <noreply@paper-route.com>", request))
      .toMatchObject({ domain: "paper-route.com", found: false, verified: false });
  });

  it("requires Resend mode and recipient protection in preview and staging", () => {
    const ready = { environment: "preview" as const, mode: "resend", apiKey: "re_redacted", webhookSecret: "whsec_redacted", sender: "Product <noreply@example.com>", recipientRedirect: "safe@example.com" };
    expect(emailDeploymentIssues(ready)).toEqual([]);
    expect(emailDeploymentIssues({ ...ready, mode: "local", recipientRedirect: "CHANGE_ME" }))
      .toEqual(["EMAIL_DELIVERY_MODE must be resend", "preview recipient redirect is not configured"]);
    expect(emailDeploymentIssues({ ...ready, environment: "staging", recipientRedirect: "invalid" }))
      .toEqual(["staging recipient redirect must be a valid email address"]);
  });

  it("does not require a redirect in production but rejects malformed senders and keys", () => {
    const config = { environment: "production" as const, mode: "resend", apiKey: "re_redacted", webhookSecret: "whsec_redacted", sender: "noreply@example.com" };
    expect(emailDeploymentIssues(config)).toEqual([]);
    expect(emailDeploymentIssues({ ...config, apiKey: "not-a-key", sender: "@example.com" }))
      .toEqual(["RESEND_API_KEY must start with re_", "EMAIL_FROM must contain a valid email address"]);
    expect(emailDeploymentIssues({ ...config, webhookSecret: "CHANGE_ME" }))
      .toEqual(["RESEND_WEBHOOK_SECRET must start with whsec_"]);
    expect(emailDeploymentIssues({ ...config, apiKey: "re_", webhookSecret: "whsec_" }))
      .toEqual(["RESEND_API_KEY must start with re_", "RESEND_WEBHOOK_SECRET must start with whsec_"]);
  });
});
