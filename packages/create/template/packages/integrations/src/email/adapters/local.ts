import { formatAddress, formatAddresses } from "../address.js";
import { renderEmail } from "../render.js";
import { EmailAlreadySent, EmailRejected, EmailValidationError } from "../types.js";
import type { EmailLogger, EmailMessage, EmailReceipt, EmailService, ScheduledEmail, SendEmailOptions } from "../types.js";

export type CapturedEmail = { id: string; to: string[]; cc: string[]; bcc: string[]; replyTo: string[]; from?: string; subject: string; template: string; templateProps: unknown; html: string; text: string; createdAt: string; acceptedAt?: string; scheduledAt?: string; status: "accepted" | "scheduled" | "cancelled" };
export type EmailClock = { now(): Date };
export const systemEmailClock: EmailClock = { now: () => new Date() };

export class LocalEmailStore {
  readonly messages = new Map<string, CapturedEmail>();
  readonly idempotency = new Map<string, { id: string; signature: string }>();
  list(): CapturedEmail[] { return [...this.messages.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id: string): CapturedEmail | undefined { return this.messages.get(id); }
  clear(): void { this.messages.clear(); this.idempotency.clear(); }
}

export const localEmailStore = new LocalEmailStore();

function messageSignature(message: EmailMessage): string {
  return JSON.stringify({ from: message.from, to: message.to, cc: message.cc, bcc: message.bcc, replyTo: message.replyTo, subject: message.subject, template: message.template.name, props: message.template.props });
}

export class LocalEmailAdapter implements EmailService {
  constructor(private readonly store = localEmailStore, private readonly clock: EmailClock = systemEmailClock, private readonly logger?: EmailLogger) {}

  async send(message: EmailMessage, options: SendEmailOptions = {}): Promise<EmailReceipt> {
    const started = this.clock.now();
    this.logger?.("email.send.started", this.fields(message, options));
    const existing = this.idempotent(message, options.idempotencyKey);
    if (existing) {
      if (existing.status === "cancelled") throw new EmailRejected("idempotency key belongs to a cancelled email");
      return { id: existing.id, acceptedAt: new Date(existing.acceptedAt ?? existing.createdAt) };
    }
    const captured = await this.capture(message, "accepted", started);
    this.remember(message, options.idempotencyKey, captured.id);
    this.logger?.("email.send.accepted", { ...this.fields(message, options), emailDeliveryId: captured.id, durationMs: this.clock.now().getTime() - started.getTime() });
    return { id: captured.id, acceptedAt: started };
  }

  async schedule(message: EmailMessage, sendAt: Date, options: SendEmailOptions = {}): Promise<ScheduledEmail> {
    if (!Number.isFinite(sendAt.getTime()) || sendAt <= this.clock.now()) throw new EmailValidationError("sendAt must be a valid future date");
    const existing = this.idempotent(message, options.idempotencyKey);
    if (existing) return { id: existing.id, sendAt: new Date(existing.scheduledAt ?? sendAt), status: existing.status === "cancelled" ? "cancelled" : existing.status === "accepted" ? "already_sent" : "scheduled" };
    const captured = await this.capture(message, "scheduled", this.clock.now(), sendAt);
    this.remember(message, options.idempotencyKey, captured.id);
    this.logger?.("email.schedule.created", { ...this.fields(message, options), emailDeliveryId: captured.id });
    return { id: captured.id, sendAt, status: "scheduled" };
  }

  async cancel(id: string): Promise<ScheduledEmail> {
    const message = this.store.get(id);
    if (!message) return { id, sendAt: this.clock.now(), status: "not_found" };
    const sendAt = new Date(message.scheduledAt ?? message.createdAt);
    if (message.status === "accepted") return { id, sendAt, status: "already_sent" };
    message.status = "cancelled";
    this.logger?.("email.schedule.cancelled", { emailDeliveryId: id, template: message.template, provider: "local" });
    return { id, sendAt, status: "cancelled" };
  }

  async reschedule(id: string, sendAt: Date): Promise<ScheduledEmail> {
    if (!Number.isFinite(sendAt.getTime()) || sendAt <= this.clock.now()) throw new EmailValidationError("sendAt must be a valid future date");
    const message = this.store.get(id);
    if (!message) return { id, sendAt, status: "not_found" };
    if (message.status === "accepted") throw new EmailAlreadySent(`email ${id} was already sent`);
    message.scheduledAt = sendAt.toISOString();
    message.status = "scheduled";
    this.logger?.("email.schedule.rescheduled", { emailDeliveryId: id, template: message.template, provider: "local" });
    return { id, sendAt, status: "scheduled" };
  }

  async flushScheduledEmail(): Promise<number> {
    let flushed = 0;
    for (const message of this.store.messages.values()) {
      if (message.status === "scheduled" && message.scheduledAt && new Date(message.scheduledAt) <= this.clock.now()) {
        message.status = "accepted";
        message.acceptedAt = this.clock.now().toISOString();
        flushed += 1;
      }
    }
    return flushed;
  }

  private idempotent(message: EmailMessage, key?: string): CapturedEmail | undefined {
    if (!key) return undefined;
    const existing = this.store.idempotency.get(key);
    if (!existing) return undefined;
    if (existing.signature !== messageSignature(message)) throw new EmailValidationError("idempotency key was reused with a different message");
    return this.store.get(existing.id);
  }

  private remember(message: EmailMessage, key: string | undefined, id: string): void {
    if (key) this.store.idempotency.set(key, { id, signature: messageSignature(message) });
  }

  private async capture(message: EmailMessage, status: CapturedEmail["status"], createdAt: Date, sendAt?: Date): Promise<CapturedEmail> {
    const rendered = await renderEmail(message.template);
    const captured: CapturedEmail = {
      id: crypto.randomUUID(), to: formatAddresses(message.to), cc: message.cc?.map(formatAddress) ?? [], bcc: message.bcc?.map(formatAddress) ?? [], replyTo: message.replyTo ? formatAddresses(message.replyTo) : [],
      ...(message.from ? { from: formatAddress(message.from) } : {}), subject: message.subject, template: message.template.name, templateProps: message.template.props, html: rendered.html, text: rendered.text, createdAt: createdAt.toISOString(),
      ...(status === "accepted" ? { acceptedAt: createdAt.toISOString() } : {}), ...(sendAt ? { scheduledAt: sendAt.toISOString() } : {}), status,
    };
    this.store.messages.set(captured.id, captured);
    return captured;
  }

  private fields(message: EmailMessage, options: SendEmailOptions) {
    return { provider: "local" as const, template: message.template.name, ...(options.correlationId ? { correlationId: options.correlationId } : {}), ...(options.causationId ? { causationId: options.causationId } : {}), ...(options.organizationId ? { organizationId: options.organizationId } : {}) };
  }
}

export function listCapturedEmails(): CapturedEmail[] { return localEmailStore.list(); }
export function getCapturedEmail(id: string): CapturedEmail | undefined { return localEmailStore.get(id); }
export function clearCapturedEmails(): void { localEmailStore.clear(); }
