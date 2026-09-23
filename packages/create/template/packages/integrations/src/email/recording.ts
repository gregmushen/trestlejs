import type { EmailLogger, EmailMessage, EmailReceipt, EmailService, ScheduledEmail, SendEmailOptions } from "./types.js";

/** A privacy-safe delivery record: never the body, links, tokens, or a full address. */
export type EmailDeliveryRecord = Readonly<{
  id: string;
  provider: "local" | "resend";
  template: string;
  recipient: string;
  recipientCount: number;
  status: "captured" | "accepted" | "failed";
  failureCategory?: string;
  correlationId?: string;
  organizationId?: string;
}>;

export type EmailDeliverySink = (record: EmailDeliveryRecord) => Promise<void>;

export function maskEmailAddress(address: string): string {
  const [local = "", domain = ""] = address.split("@");
  return domain ? `${local.slice(0, 1)}***@${domain}` : "***";
}

const firstAddress = (message: EmailMessage): string => {
  const to = Array.isArray(message.to) ? message.to[0] : message.to;
  return typeof to === "string" ? to : to?.email ?? "";
};

const category = (error: unknown): string => {
  const name = error instanceof Error ? error.name : "";
  if (/RateLimited/u.test(name)) return "rate_limited";
  if (/ProviderUnavailable/u.test(name)) return "provider_unavailable";
  if (/Rejected/u.test(name)) return "rejected";
  if (/Validation/u.test(name)) return "invalid_message";
  return "unknown";
};

/**
 * Records every send through a sink so operators can see delivery status
 * without reading message content. Recording failures never block delivery.
 */
export class RecordingEmailService implements EmailService {
  constructor(private readonly inner: EmailService, private readonly provider: "local" | "resend", private readonly sink: EmailDeliverySink, private readonly logger?: EmailLogger) {}

  /** Observability must not break delivery, but a failed record is always reported. */
  private async record(record: EmailDeliveryRecord): Promise<void> {
    try { await this.sink(record); }
    catch (error) { this.logger?.("email.delivery.record_failed", { provider: this.provider, template: record.template, emailDeliveryId: record.id, failureCategory: error instanceof Error ? error.name : "unknown" }); }
  }

  async send(message: EmailMessage, options: SendEmailOptions = {}): Promise<EmailReceipt> {
    const base = {
      provider: this.provider, template: message.template.name, recipient: maskEmailAddress(firstAddress(message)),
      recipientCount: (Array.isArray(message.to) ? message.to.length : 1) + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0),
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
    };
    try {
      const receipt = await this.inner.send(message, options);
      await this.record({ ...base, id: receipt.id, status: this.provider === "local" ? "captured" : "accepted" });
      return receipt;
    } catch (error) {
      await this.record({ ...base, id: `failed-${crypto.randomUUID()}`, status: "failed", failureCategory: category(error) });
      throw error;
    }
  }

  schedule(message: EmailMessage, sendAt: Date, options?: SendEmailOptions): Promise<ScheduledEmail> { return this.inner.schedule(message, sendAt, options); }
  cancel(scheduledEmailId: string): Promise<ScheduledEmail> { return this.inner.cancel(scheduledEmailId); }
  reschedule(scheduledEmailId: string, sendAt: Date): Promise<ScheduledEmail> { return this.inner.reschedule(scheduledEmailId, sendAt); }
}
