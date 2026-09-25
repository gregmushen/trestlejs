import { describe, expect, it, vi } from "vitest";

import { verificationLink, waitForStagingVerificationLink } from "./staging-email.js";

const email = "staging-canary@example.test";
const subject = `[STAGING → ${email}] Verify your email`;
const sentAfter = new Date("2026-09-24T00:00:00.000Z");
const listed = { id: "email-test-id", to: ["private-staging-mailbox@example.com"], subject, created_at: sentAfter.toISOString() };
const link = "https://api.example.test/api/auth/verify-email?token=private-verification-token";

function request(list: unknown, detail: unknown = { ...listed, text: `Confirm: ${link}` }) {
  return vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("?limit=") ? list : detail), { status: 200 })) as unknown as typeof fetch;
}

describe("staging email verification canary", () => {
  it("finds preview redirection under its own subject prefix", async () => {
    const preview = { ...listed, subject: `[PREVIEW → ${email}] Verify your email` };
    expect(await waitForStagingVerificationLink({ apiKey: "test-key", originalEmail: email, apiOrigin: "https://api.example.test", sentAfter,
      environment: "preview", request: request({ data: [preview] }, { ...preview, text: `Confirm: ${link}` }) })).toBe(link);
  });

  it("selects only the unique, redirected test email and validates the link origin", async () => {
    const fetcher = request({ data: [
      { ...listed, id: "other", subject: "Another customer's email" },
      { ...listed, id: "old", created_at: "2026-09-23T20:00:00.000Z" },
      listed,
    ] });
    expect(await waitForStagingVerificationLink({ apiKey: "test-key", originalEmail: email, apiOrigin: "https://api.example.test", sentAfter, request: fetcher })).toBe(link);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://api.resend.com/emails/email-test-id", expect.objectContaining({ headers: { authorization: "Bearer test-key" } }));
  });

  it("rejects any message still addressed to the original recipient", async () => {
    await expect(waitForStagingVerificationLink({ apiKey: "test-key", originalEmail: email, apiOrigin: "https://api.example.test", sentAfter,
      request: request({ data: [{ ...listed, to: [email] }] }) })).rejects.toThrow("redirection was not verified");
  });

  it("follows bounded sent-email pagination without retrieving unrelated message bodies", async () => {
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith("?limit=100") ? { data: [{ ...listed, id: "older-page-cursor", subject: "Unrelated" }], has_more: true }
        : url.includes("after=older-page-cursor") ? { data: [listed], has_more: false }
          : { ...listed, text: link },
    ), { status: 200 })) as unknown as typeof fetch;
    expect(await waitForStagingVerificationLink({ apiKey: "test-key", originalEmail: email, apiOrigin: "https://api.example.test", sentAfter, request: fetcher })).toBe(link);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("retries a matching message until its rendered content is available", async () => {
    let detailReads = 0;
    let clock = sentAfter.getTime();
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("?limit=")
      ? { data: [listed] }
      : { ...listed, text: ++detailReads === 1 ? null : link }), { status: 200 })) as unknown as typeof fetch;
    expect(await waitForStagingVerificationLink({ apiKey: "test-key", originalEmail: email, apiOrigin: "https://api.example.test", sentAfter,
      request: fetcher, now: () => clock, pause: async (ms) => { clock += ms; } })).toBe(link);
    expect(detailReads).toBe(2);
  });

  it("does not accept a mismatched retrieved message or leak its content", async () => {
    await expect(waitForStagingVerificationLink({ apiKey: "test-key", originalEmail: email, apiOrigin: "https://api.example.test", sentAfter,
      request: request({ data: [listed] }, { ...listed, to: ["other@example.test"], text: link }) })).rejects.toThrow("did not match");
  });

  it("accepts an HTML link but rejects another origin or another auth path", () => {
    expect(verificationLink({ html: `<a href="${link.replace("?", "?foo=1&amp;")}">Verify</a>` }, "https://api.example.test"))
      .toBe("https://api.example.test/api/auth/verify-email?foo=1&token=private-verification-token");
    expect(verificationLink({ text: "https://attacker.example/api/auth/verify-email?token=stolen" }, "https://api.example.test")).toBeNull();
    expect(verificationLink({ text: "https://api.example.test/api/auth/reset-password?token=stolen" }, "https://api.example.test")).toBeNull();
  });

  it("times out without printing an email body or querying unrelated messages", async () => {
    const fetcher = request({ data: [{ ...listed, subject: "Unrelated" }] });
    await expect(waitForStagingVerificationLink({ apiKey: "test-key", originalEmail: email, apiOrigin: "https://api.example.test", sentAfter,
      request: fetcher, timeoutMs: 0, now: () => sentAfter.getTime() })).rejects.toThrow("not found before the deadline");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails with a safe error when the Resend API rejects inspection", async () => {
    await expect(waitForStagingVerificationLink({ apiKey: "private-key", originalEmail: email, apiOrigin: "https://api.example.test", sentAfter,
      request: vi.fn(async () => new Response("private provider payload", { status: 403 })) as unknown as typeof fetch })).rejects.toThrow("HTTP 403");
  });
});
