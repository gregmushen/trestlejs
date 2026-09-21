import { formatAddresses } from "./address.js";
import type { EmailAddress, EmailMessage, EmailReceipt, EmailService, ScheduledEmail, SendEmailOptions } from "./types.js";

export class StagingRedirectEmailService implements EmailService {
  constructor(private readonly inner: EmailService, private readonly recipient: EmailAddress) {}
  send(message: EmailMessage, options?: SendEmailOptions): Promise<EmailReceipt> { return this.inner.send(this.redirect(message), options); }
  schedule(message: EmailMessage, sendAt: Date, options?: SendEmailOptions): Promise<ScheduledEmail> { return this.inner.schedule(this.redirect(message), sendAt, options); }
  cancel(id: string): Promise<ScheduledEmail> { return this.inner.cancel(id); }
  reschedule(id: string, sendAt: Date): Promise<ScheduledEmail> { return this.inner.reschedule(id, sendAt); }
  private redirect(message: EmailMessage): EmailMessage {
    const original = formatAddresses(message.to).join(", ");
    return { ...message, to: this.recipient, cc: [], bcc: [], subject: `[STAGING → ${original}] ${message.subject}` };
  }
}
