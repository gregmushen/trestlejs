import { and, asc, eq, inArray, isNotNull, lte, or } from "drizzle-orm";

import type { Database } from "./index.js";
import { webhookAttempt } from "./webhook-attempt-schema.js";
import { webhookDelivery, webhookMessage } from "./webhook-projection-schema.js";

export type WebhookPayloadRetentionResult = {
  redacted: number;
  skippedActiveLeases: number;
  stoppedDeliveries: number;
  clearedAttempts: number;
};

/** Erase public payload and captured local request material together. The
 * caller supplies effective class cutoffs after policy/entitlement/provider
 * limits are resolved. Delivery and attempt metadata remain available. */
export async function redactExpiredWebhookPayloads(input: {
  organizationId: string;
  tenantDatabase: (organizationId: string) => Database;
  clock: { now(): Date };
  cutoffs: { standard: Date; short: Date };
  limit?: number;
}): Promise<WebhookPayloadRetentionResult> {
  const now = input.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invalid webhook retention clock");
  const { standard, short } = input.cutoffs;
  if (![standard, short].every((value) => value instanceof Date && Number.isFinite(value.getTime()) && value.getTime() <= now.getTime())) {
    throw new Error("Invalid webhook payload retention cutoffs");
  }
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid webhook retention page size");
  const result: WebhookPayloadRetentionResult = { redacted: 0, skippedActiveLeases: 0, stoppedDeliveries: 0, clearedAttempts: 0 };
  const database = input.tenantDatabase(input.organizationId);
  await database.transaction(async (transaction) => {
    const messages = await transaction.select({ id: webhookMessage.id }).from(webhookMessage).where(and(
      eq(webhookMessage.organizationId, input.organizationId),
      isNotNull(webhookMessage.envelope),
      or(
        and(eq(webhookMessage.retentionClass, "standard"), lte(webhookMessage.createdAt, standard)),
        and(eq(webhookMessage.retentionClass, "short"), lte(webhookMessage.createdAt, short)),
      ),
    )).orderBy(asc(webhookMessage.createdAt), asc(webhookMessage.id)).limit(limit).for("update", { skipLocked: true });
    for (const message of messages) {
      const deliveries = await transaction.select({
        id: webhookDelivery.id, state: webhookDelivery.state, leasedUntil: webhookDelivery.leasedUntil,
      }).from(webhookDelivery).where(and(
        eq(webhookDelivery.organizationId, input.organizationId), eq(webhookDelivery.messageId, message.id),
      )).for("update");
      if (deliveries.some((delivery) => delivery.state === "leased" && delivery.leasedUntil && delivery.leasedUntil.getTime() > now.getTime())) {
        result.skippedActiveLeases++;
        continue;
      }
      const stopped = await transaction.update(webhookDelivery).set({
        state: "dead", nextAttemptAt: null, leaseToken: null, leasedUntil: null,
        terminalReason: "payload_expired", completedAt: now,
      }).where(and(
        eq(webhookDelivery.organizationId, input.organizationId), eq(webhookDelivery.messageId, message.id),
        inArray(webhookDelivery.state, ["pending", "retry", "leased"]),
      )).returning();
      result.stoppedDeliveries += stopped.length;
      const deliveryIds = deliveries.map(({ id }) => id);
      if (deliveryIds.length > 0) {
        const cleared = await transaction.update(webhookAttempt).set({
          requestUrl: null, requestHeaders: {}, requestBody: null,
        }).where(and(
          eq(webhookAttempt.organizationId, input.organizationId),
          inArray(webhookAttempt.deliveryId, deliveryIds),
        )).returning();
        result.clearedAttempts += cleared.length;
      }
      const [redacted] = await transaction.update(webhookMessage).set({
        envelope: null, payloadDeletedAt: now,
      }).where(and(
        eq(webhookMessage.organizationId, input.organizationId), eq(webhookMessage.id, message.id),
        isNotNull(webhookMessage.envelope),
      )).returning();
      if (redacted) result.redacted++;
    }
  });
  return result;
}
