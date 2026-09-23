import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import type { Database } from "./index.js";
import { webhookDelivery, webhookMessage } from "./webhook-projection-schema.js";
import { webhookEndpoint } from "./webhook-schema.js";
import type { NativeWebhookWakeup } from "./webhook-work.js";

/** Find only due, tenant-scoped native deliveries. A recovery wake-up is an
 * ID hint, never an authorization decision; the consumer rechecks the outbox. */
export async function dueNativeWebhookWakeups(input: {
  organizationId: string;
  environment: "preview" | "staging" | "production";
  tenantDatabase: (organizationId: string) => Database;
  now: Date;
  limit?: number;
}): Promise<NativeWebhookWakeup[]> {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) throw new Error("Invalid native webhook recovery clock");
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid native webhook recovery page size");
  const rows = await input.tenantDatabase(input.organizationId).select({
    sourceEventId: webhookMessage.sourceEventId,
    deliveryId: webhookDelivery.id,
  }).from(webhookDelivery)
    .innerJoin(webhookMessage, and(eq(webhookMessage.id, webhookDelivery.messageId), eq(webhookMessage.organizationId, webhookDelivery.organizationId)))
    .innerJoin(webhookEndpoint, and(eq(webhookEndpoint.id, webhookDelivery.endpointId), eq(webhookEndpoint.organizationId, webhookDelivery.organizationId)))
    .where(and(
      eq(webhookDelivery.organizationId, input.organizationId),
      or(
        and(inArray(webhookDelivery.state, ["pending", "retry"]), lte(webhookDelivery.nextAttemptAt, input.now)),
        and(eq(webhookDelivery.state, "leased"), lte(webhookDelivery.leasedUntil, input.now)),
      ),
      eq(webhookMessage.status, "ready"), isNull(webhookMessage.payloadDeletedAt),
      eq(webhookEndpoint.provider, "native"), eq(webhookEndpoint.environment, input.environment),
      eq(webhookEndpoint.state, "active"), isNull(webhookEndpoint.deletedAt),
    )).orderBy(asc(webhookDelivery.nextAttemptAt), asc(webhookDelivery.id)).limit(limit);
  return rows;
}
