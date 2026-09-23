import { and, eq, gt, isNull } from "drizzle-orm";

import type { Database } from "./index.js";
import { webhookDelivery, webhookMessage } from "./webhook-projection-schema.js";
import { webhookEndpoint } from "./webhook-schema.js";

export type NativeWebhookAttemptPayload = {
  endpointId: string;
  destinationUrl: string;
  messageId: string;
  body: string;
  correlationId: string;
};

/** Only the current, unexpired lease holder may load a public payload for
 * network delivery. Tenant context comes from the committed event, not Queue. */
export async function loadNativeWebhookAttempt(input: {
  organizationId: string;
  deliveryId: string;
  leaseToken: string;
  environment: "preview" | "staging" | "production";
  tenantDatabase: (organizationId: string) => Database;
  clock: { now(): Date };
}): Promise<NativeWebhookAttemptPayload | null> {
  const now = input.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invalid native webhook clock");
  const [record] = await input.tenantDatabase(input.organizationId).select({
    endpointId: webhookEndpoint.id,
    destinationUrl: webhookEndpoint.destinationUrl,
    messageId: webhookMessage.id,
    envelope: webhookMessage.envelope,
    correlationId: webhookMessage.correlationId,
  }).from(webhookDelivery)
    .innerJoin(webhookMessage, and(eq(webhookMessage.id, webhookDelivery.messageId), eq(webhookMessage.organizationId, webhookDelivery.organizationId)))
    .innerJoin(webhookEndpoint, and(eq(webhookEndpoint.id, webhookDelivery.endpointId), eq(webhookEndpoint.organizationId, webhookDelivery.organizationId)))
    .where(and(
      eq(webhookDelivery.id, input.deliveryId), eq(webhookDelivery.organizationId, input.organizationId),
      eq(webhookDelivery.state, "leased"), eq(webhookDelivery.leaseToken, input.leaseToken), gt(webhookDelivery.leasedUntil, now),
      eq(webhookEndpoint.provider, "native"), eq(webhookEndpoint.environment, input.environment),
      eq(webhookEndpoint.state, "active"), isNull(webhookEndpoint.deletedAt),
      eq(webhookMessage.status, "ready"), isNull(webhookMessage.payloadDeletedAt),
    )).limit(1);
  if (!record || !record.envelope) return null;
  return { endpointId: record.endpointId, destinationUrl: record.destinationUrl, messageId: record.messageId, body: JSON.stringify(record.envelope), correlationId: record.correlationId };
}
