import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createDatabase, createTenantDatabase, dueNativeWebhookWakeups, expireUnprovenNativeWebhookDeliveries, nextMaintenanceOrganizations, type NativeWebhookWakeup } from "@__TRESTLE_PROJECT_NAME__/db";
import type { CloudflareQueueBinding } from "@__TRESTLE_PROJECT_NAME__/events";

export type NativeWebhookRecoveryResult = { organizations: number; queued: number; expired: number; failed: number };

/** Cron repairs lost Queue handoffs and expired leases. Bounded organization
 * pages keep a large installation from monopolizing one scheduled invocation.
 * Deliveries whose committed source event was pruned or is past the replay
 * window are settled as exhausted first: a wake-up for them can never run. */
export async function maintainNativeWebhookDeliveries(input: {
  environment: AuthEnvironment;
  queue: CloudflareQueueBinding<NativeWebhookWakeup>;
  now?: Date;
}): Promise<NativeWebhookRecoveryResult> {
  const { environment, queue } = input;
  if (environment.WEBHOOK_DELIVERY_MODE !== "native" || !environment.APP_ENV || environment.APP_ENV === "local" || !environment.WEBHOOK_SECRET_KEY) {
    throw new Error("Native webhook recovery requires remote native mode and a signing key");
  }
  const now = input.now ?? new Date();
  const database = createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER);
  const organizations = await nextMaintenanceOrganizations(database, "native-webhook-recovery");
  const result: NativeWebhookRecoveryResult = { organizations: organizations.length, queued: 0, expired: 0, failed: 0 };
  for (const organizationId of organizations) {
    try {
      const tenantDatabase = (tenant: string) => createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, tenant);
      result.expired += await expireUnprovenNativeWebhookDeliveries({ organizationId, environment: environment.APP_ENV, tenantDatabase, now });
      const due = await dueNativeWebhookWakeups({ organizationId, environment: environment.APP_ENV, tenantDatabase, now });
      for (const wakeup of due) {
        await queue.send(wakeup, { contentType: "json" });
        result.queued++;
      }
    } catch { result.failed++; }
  }
  return result;
}
