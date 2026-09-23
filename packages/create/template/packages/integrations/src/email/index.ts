export * from "./types.js";
export * from "./render.js";
export * from "./adapters/local.js";
export * from "./adapters/resend.js";
export * from "./staging.js";
export * from "./webhooks.js";
export * from "./recording.js";
export * from "./templates/verify-email.js";
export * from "./templates/reset-password.js";
export * from "./templates/invitation.js";
export * from "./templates/security-alert.js";
export * from "./templates/notification.js";

import { LocalEmailAdapter } from "./adapters/local.js";
import { ResendEmailAdapter } from "./adapters/resend.js";
import { StagingRedirectEmailService } from "./staging.js";
import { EmailValidationError } from "./types.js";
import type { EmailLogger, EmailService } from "./types.js";

import { RecordingEmailService, type EmailDeliverySink } from "./recording.js";

export type EmailConfiguration = { mode?: "local" | "resend"; environment?: "local" | "preview" | "staging" | "production"; resendApiKey?: string; from?: string; replyTo?: string; stagingRedirect?: string; logger?: EmailLogger; deliverySink?: EmailDeliverySink };

export function createEmailService(configuration: EmailConfiguration): EmailService {
  const service = createProviderEmailService(configuration);
  return configuration.deliverySink ? new RecordingEmailService(service, (configuration.mode ?? "local") === "local" ? "local" : "resend", configuration.deliverySink, configuration.logger) : service;
}

function createProviderEmailService(configuration: EmailConfiguration): EmailService {
  if ((configuration.mode ?? "local") === "local") return new LocalEmailAdapter(undefined, undefined, configuration.logger);
  if (!configuration.resendApiKey) throw new EmailValidationError("RESEND_API_KEY is required for the Resend email adapter");
  if (!configuration.from) throw new EmailValidationError("EMAIL_FROM is required for the Resend email adapter");
  const service: EmailService = new ResendEmailAdapter({ apiKey: configuration.resendApiKey, from: configuration.from, ...(configuration.replyTo ? { replyTo: configuration.replyTo } : {}), ...(configuration.logger ? { logger: configuration.logger } : {}) });
  if (configuration.environment === "staging") {
    if (!configuration.stagingRedirect) throw new EmailValidationError("EMAIL_STAGING_REDIRECT is required in staging");
    return new StagingRedirectEmailService(service, configuration.stagingRedirect);
  }
  return service;
}
