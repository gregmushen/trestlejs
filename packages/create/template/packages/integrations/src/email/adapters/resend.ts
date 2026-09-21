import { Resend } from "resend";
import { formatAddress, formatAddresses } from "../address.js";
import { renderEmail } from "../render.js";
import { EmailAlreadySent, EmailProviderUnavailable, EmailRateLimited, EmailRejected, EmailValidationError } from "../types.js";
import type { EmailAddress, EmailLogger, EmailMessage, EmailReceipt, EmailService, ScheduledEmail, SendEmailOptions } from "../types.js";

export type ResendEmailAdapterOptions = { apiKey: string; from: EmailAddress; replyTo?: EmailAddress; logger?: EmailLogger };

function normalizeError(error: { name?: string; message?: string; statusCode?: number | null } | null): Error {
  const message = error?.message ?? "Resend rejected the email operation";
  if (error?.statusCode === 429 || error?.name === "rate_limit_exceeded") return new EmailRateLimited(message);
  if (error?.statusCode === 400 || error?.name === "validation_error" || error?.name === "invalid_idempotent_request") return new EmailValidationError(message);
  if (error?.statusCode && error.statusCode >= 500) return new EmailProviderUnavailable(message);
  return new EmailRejected(message);
}

export class ResendEmailAdapter implements EmailService {
  private readonly client: Resend;
  constructor(private readonly options: ResendEmailAdapterOptions) { this.client = new Resend(options.apiKey); }

  async send(message: EmailMessage, sendOptions: SendEmailOptions = {}): Promise<EmailReceipt> {
    const startedAt = new Date();
    this.options.logger?.("email.send.started", this.fields(message, sendOptions));
    const { data, error } = await this.client.emails.send(await this.payload(message), sendOptions.idempotencyKey ? { idempotencyKey: sendOptions.idempotencyKey } : undefined);
    if (error || !data) {
      const normalized = normalizeError(error);
      this.options.logger?.("email.send.failed", { ...this.fields(message, sendOptions), failureCategory: normalized.constructor.name });
      throw normalized;
    }
    this.options.logger?.("email.send.accepted", { ...this.fields(message, sendOptions), emailDeliveryId: data.id, durationMs: Date.now() - startedAt.getTime() });
    return { id: data.id, acceptedAt: new Date() };
  }

  async schedule(message: EmailMessage, sendAt: Date, sendOptions: SendEmailOptions = {}): Promise<ScheduledEmail> {
    if (!Number.isFinite(sendAt.getTime()) || sendAt <= new Date()) throw new EmailValidationError("sendAt must be a valid future date");
    const { data, error } = await this.client.emails.send({ ...(await this.payload(message)), scheduledAt: sendAt.toISOString() }, sendOptions.idempotencyKey ? { idempotencyKey: sendOptions.idempotencyKey } : undefined);
    if (error || !data) throw normalizeError(error);
    this.options.logger?.("email.schedule.created", { ...this.fields(message, sendOptions), emailDeliveryId: data.id });
    return { id: data.id, sendAt, status: "scheduled" };
  }

  async cancel(id: string): Promise<ScheduledEmail> {
    const { error } = await this.client.emails.cancel(id);
    if (error) {
      if (error.name === "not_found") return { id, sendAt: new Date(), status: "not_found" };
      if (error.name === "validation_error" && /already/i.test(error.message)) return { id, sendAt: new Date(), status: "already_sent" };
      throw normalizeError(error);
    }
    this.options.logger?.("email.schedule.cancelled", { provider: "resend", emailDeliveryId: id });
    return { id, sendAt: new Date(), status: "cancelled" };
  }

  async reschedule(id: string, sendAt: Date): Promise<ScheduledEmail> {
    if (!Number.isFinite(sendAt.getTime()) || sendAt <= new Date()) throw new EmailValidationError("sendAt must be a valid future date");
    const { error } = await this.client.emails.update({ id, scheduledAt: sendAt.toISOString() });
    if (error) {
      if (error.name === "not_found") return { id, sendAt, status: "not_found" };
      if (error.name === "validation_error" && /already/i.test(error.message)) throw new EmailAlreadySent(error.message);
      throw normalizeError(error);
    }
    this.options.logger?.("email.schedule.rescheduled", { provider: "resend", emailDeliveryId: id });
    return { id, sendAt, status: "scheduled" };
  }

  private async payload(message: EmailMessage) {
    const rendered = await renderEmail(message.template);
    return { from: formatAddress(message.from ?? this.options.from), to: formatAddresses(message.to), subject: message.subject, html: rendered.html, text: rendered.text, ...(message.cc ? { cc: message.cc.map(formatAddress) } : {}), ...(message.bcc ? { bcc: message.bcc.map(formatAddress) } : {}), ...(message.replyTo ? { replyTo: formatAddresses(message.replyTo) } : this.options.replyTo ? { replyTo: formatAddress(this.options.replyTo) } : {}) };
  }

  private fields(message: EmailMessage, options: SendEmailOptions) {
    return { provider: "resend" as const, template: message.template.name, ...(options.correlationId ? { correlationId: options.correlationId } : {}), ...(options.causationId ? { causationId: options.causationId } : {}), ...(options.organizationId ? { organizationId: options.organizationId } : {}) };
  }
}
