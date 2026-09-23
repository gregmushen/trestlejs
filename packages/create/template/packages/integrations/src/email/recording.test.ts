import { describe, expect, it } from "vitest";

import { LocalEmailAdapter } from "./adapters/local.js";
import { maskEmailAddress, RecordingEmailService, type EmailDeliveryRecord } from "./recording.js";
import { verifyEmailTemplate } from "./templates/verify-email.js";
import type { EmailService } from "./types.js";

describe("recording email service", () => {
  it("records template, masked recipient, and status without content", async () => {
    const records: EmailDeliveryRecord[] = [];
    const service = new RecordingEmailService(new LocalEmailAdapter(), "local", async (record) => { records.push(record); });
    const receipt = await service.send({ to: "olive@example.com", subject: "Verify", template: verifyEmailTemplate({ verificationUrl: "https://app.test/verify?token=secret-token" }) }, { correlationId: "corr-1" });
    expect(records).toEqual([{ id: receipt.id, provider: "local", template: "verify-email", recipient: "o***@example.com", recipientCount: 1, status: "captured", correlationId: "corr-1" }]);
    expect(JSON.stringify(records)).not.toContain("secret-token");
  });

  it("records failures with a category and never lets recording break delivery", async () => {
    class ProviderUnavailable extends Error { override name = "EmailProviderUnavailable"; }
    const failing = { send: async () => { throw new ProviderUnavailable("down"); } } as unknown as EmailService;
    const records: EmailDeliveryRecord[] = [];
    await expect(new RecordingEmailService(failing, "resend", async (record) => { records.push(record); }).send({ to: "a@b.test", subject: "x", template: verifyEmailTemplate({ verificationUrl: "https://x.test" }) })).rejects.toThrow("down");
    expect(records[0]).toMatchObject({ status: "failed", failureCategory: "provider_unavailable", provider: "resend" });
    const logged: string[] = [];
    const broken = new RecordingEmailService(new LocalEmailAdapter(), "local", async () => { throw new Error("database down"); }, (event) => { logged.push(event); });
    await expect(broken.send({ to: "a@b.test", subject: "x", template: verifyEmailTemplate({ verificationUrl: "https://x.test" }) })).resolves.toMatchObject({ id: expect.any(String) });
    expect(logged).toContain("email.delivery.record_failed");
    expect(maskEmailAddress("nobody")).toBe("***");
  });
});
