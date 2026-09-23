import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createDatabase, createTenantDatabase, nextMaintenanceOrganizations, redactExpiredWebhookPayloads, type WebhookPayloadRetentionResult } from "@__TRESTLE_PROJECT_NAME__/db";

export type WebhookRetentionMaintenanceResult = WebhookPayloadRetentionResult & { organizations: number; failed: number };

/** The application owns these defaults. Short-class payloads are retained for
 * seven days; standard payloads for thirty. A future configured/provider
 * policy can pass stricter effective cutoffs to the database operation. */
export async function runWebhookRetentionMaintenance(
  organizations: () => Promise<string[]>,
  redact: (organizationId: string, cutoffs: { standard: Date; short: Date }) => Promise<WebhookPayloadRetentionResult>,
  now: Date,
): Promise<WebhookRetentionMaintenanceResult> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invalid webhook retention clock");
  const day = 24 * 60 * 60_000;
  const cutoffs = { standard: new Date(now.getTime() - 30 * day), short: new Date(now.getTime() - 7 * day) };
  const ids = await organizations();
  const result: WebhookRetentionMaintenanceResult = { organizations: ids.length, redacted: 0, skippedActiveLeases: 0, stoppedDeliveries: 0, clearedAttempts: 0, failed: 0 };
  for (const organizationId of ids) {
    try {
      const handled = await redact(organizationId, cutoffs);
      result.redacted += handled.redacted;
      result.skippedActiveLeases += handled.skippedActiveLeases;
      result.stoppedDeliveries += handled.stoppedDeliveries;
      result.clearedAttempts += handled.clearedAttempts;
    } catch { result.failed++; }
  }
  return result;
}

export async function maintainWebhookPayloads(environment: AuthEnvironment, now = new Date()): Promise<WebhookRetentionMaintenanceResult> {
  if (environment.WEBHOOK_DELIVERY_MODE !== "local" || environment.APP_ENV !== "local") {
    throw new Error("Local webhook retention requires local delivery mode and environment");
  }
  const database = createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER);
  return runWebhookRetentionMaintenance(
    () => nextMaintenanceOrganizations(database, "webhook-payloads"),
    (organizationId, cutoffs) => redactExpiredWebhookPayloads({
      organizationId, tenantDatabase: (tenant) => createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, tenant),
      clock: { now: () => now }, cutoffs,
    }),
    now,
  );
}
