import type { ReactElement } from "react";

export type EmailAddress = string | { email: string; name?: string };
export type EmailDeliveryId = string;
export type ScheduledEmailStatus = "scheduled" | "cancelled" | "already_sent" | "not_found" | "provider_rejected";
export type EmailTemplate<Props = unknown> = { name: string; props: Props; render: () => ReactElement };
export type EmailMessage = { from?: EmailAddress; to: EmailAddress | EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[]; replyTo?: EmailAddress | EmailAddress[]; subject: string; template: EmailTemplate };
export type SendEmailOptions = { idempotencyKey?: string; correlationId?: string; causationId?: string; organizationId?: string };
export type EmailReceipt = { id: EmailDeliveryId; acceptedAt: Date };
export type ScheduledEmail = { id: EmailDeliveryId; sendAt: Date; status: ScheduledEmailStatus };

export interface EmailService {
  send(message: EmailMessage, options?: SendEmailOptions): Promise<EmailReceipt>;
  schedule(message: EmailMessage, sendAt: Date, options?: SendEmailOptions): Promise<ScheduledEmail>;
  cancel(scheduledEmailId: string): Promise<ScheduledEmail>;
  reschedule(scheduledEmailId: string, sendAt: Date): Promise<ScheduledEmail>;
}

export type EmailLogEvent = "email.send.started" | "email.send.accepted" | "email.send.failed" | "email.schedule.created" | "email.schedule.cancelled" | "email.schedule.rescheduled" | "email.schedule.failed" | "email.delivery.record_failed";
export type EmailLogFields = { emailDeliveryId?: string; template?: string; provider: "local" | "resend"; correlationId?: string; causationId?: string; organizationId?: string; durationMs?: number; failureCategory?: string };
export type EmailLogger = (event: EmailLogEvent, fields: EmailLogFields) => void;

export class EmailValidationError extends Error {}
export class EmailProviderUnavailable extends Error {}
export class EmailRateLimited extends Error {}
export class EmailRejected extends Error {}
export class EmailScheduleUnsupported extends Error {}
export class EmailAlreadySent extends Error {}
