import { and, desc, eq, isNull } from "drizzle-orm";

import type { Database } from "./index.js";
import { webhookAttempt } from "./webhook-attempt-schema.js";
import { webhookDelivery, webhookMessage } from "./webhook-projection-schema.js";
import { webhookEndpoint, webhookSubscription } from "./webhook-schema.js";

function inspectionLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid webhook inspection page size");
  return limit;
}

function destinationHost(destination: string): string {
  try { return new URL(destination).host; }
  catch { return "invalid-destination"; }
}

/** The selected fields form a deliberately metadata-only customer read model.
 * Caller authorization and forced tenant RLS are separate required layers. */
export async function listWebhookEndpoints(input: {
  organizationId: string;
  environment: "local" | "preview" | "staging" | "production";
  tenantDatabase: (organizationId: string) => Database;
  limit?: number;
}) {
  const limit = inspectionLimit(input.limit ?? 50);
  const database = input.tenantDatabase(input.organizationId);
  const endpoints = await database.select({
    id: webhookEndpoint.id, name: webhookEndpoint.name, destinationUrl: webhookEndpoint.destinationUrl,
    state: webhookEndpoint.state, health: webhookEndpoint.health, provider: webhookEndpoint.provider,
    createdAt: webhookEndpoint.createdAt, updatedAt: webhookEndpoint.updatedAt,
  }).from(webhookEndpoint).where(and(
    eq(webhookEndpoint.organizationId, input.organizationId), eq(webhookEndpoint.environment, input.environment), isNull(webhookEndpoint.deletedAt),
  )).orderBy(desc(webhookEndpoint.createdAt), desc(webhookEndpoint.id)).limit(limit);
  return await Promise.all(endpoints.map(async (endpoint) => {
    const subscriptions = await database.select({ type: webhookSubscription.publicEventType, version: webhookSubscription.publicVersion })
      .from(webhookSubscription).where(and(eq(webhookSubscription.organizationId, input.organizationId), eq(webhookSubscription.endpointId, endpoint.id)));
    return {
      id: endpoint.id, name: endpoint.name, destinationHost: destinationHost(endpoint.destinationUrl),
      state: endpoint.state, health: endpoint.health, provider: endpoint.provider,
      subscriptionCount: subscriptions.length, createdAt: endpoint.createdAt, updatedAt: endpoint.updatedAt,
    };
  }));
}

/** Null means the endpoint is absent in this tenant/environment; [] is a legacy empty selection. */
export async function listWebhookSubscriptions(input: {
  organizationId: string;
  environment: "local" | "preview" | "staging" | "production";
  endpointId: string;
  tenantDatabase: (organizationId: string) => Database;
}): Promise<Array<{ type: string; version: number }> | null> {
  const database = input.tenantDatabase(input.organizationId);
  const [endpoint] = await database.select({ id: webhookEndpoint.id }).from(webhookEndpoint).where(and(
    eq(webhookEndpoint.id, input.endpointId), eq(webhookEndpoint.organizationId, input.organizationId),
    eq(webhookEndpoint.environment, input.environment), isNull(webhookEndpoint.deletedAt),
  )).limit(1);
  if (!endpoint) return null;
  return database.select({ type: webhookSubscription.publicEventType, version: webhookSubscription.publicVersion })
    .from(webhookSubscription).where(and(eq(webhookSubscription.organizationId, input.organizationId), eq(webhookSubscription.endpointId, input.endpointId)))
    .orderBy(webhookSubscription.publicEventType, webhookSubscription.publicVersion);
}

export async function listWebhookDeliveries(input: {
  organizationId: string;
  environment: "local" | "preview" | "staging" | "production";
  endpointId: string;
  tenantDatabase: (organizationId: string) => Database;
  limit?: number;
}) {
  const limit = inspectionLimit(input.limit ?? 50);
  const rows = await input.tenantDatabase(input.organizationId).select({
    id: webhookDelivery.id, messageId: webhookMessage.id, eventType: webhookMessage.publicEventType,
    eventVersion: webhookMessage.publicVersion, occurredAt: webhookMessage.occurredAt,
    state: webhookDelivery.state, attemptCount: webhookDelivery.attemptCount,
    nextAttemptAt: webhookDelivery.nextAttemptAt, terminalReason: webhookDelivery.terminalReason,
    createdAt: webhookDelivery.createdAt, completedAt: webhookDelivery.completedAt,
    payloadDeletedAt: webhookMessage.payloadDeletedAt, messageStatus: webhookMessage.status,
    correlationId: webhookMessage.correlationId,
  }).from(webhookDelivery)
    .innerJoin(webhookMessage, and(eq(webhookMessage.id, webhookDelivery.messageId), eq(webhookMessage.organizationId, webhookDelivery.organizationId)))
    .innerJoin(webhookEndpoint, and(eq(webhookEndpoint.id, webhookDelivery.endpointId), eq(webhookEndpoint.organizationId, webhookDelivery.organizationId)))
    .where(and(
      eq(webhookDelivery.organizationId, input.organizationId), eq(webhookDelivery.endpointId, input.endpointId),
      eq(webhookEndpoint.environment, input.environment), isNull(webhookEndpoint.deletedAt),
    )).orderBy(desc(webhookDelivery.createdAt), desc(webhookDelivery.id)).limit(limit);
  return rows.map(({ payloadDeletedAt, messageStatus, ...row }) => ({
    ...row, payloadAvailable: !payloadDeletedAt && messageStatus === "ready",
  }));
}

export async function listWebhookAttempts(input: {
  organizationId: string;
  environment: "local" | "preview" | "staging" | "production";
  deliveryId: string;
  tenantDatabase: (organizationId: string) => Database;
  limit?: number;
}) {
  const limit = inspectionLimit(input.limit ?? 50);
  return await input.tenantDatabase(input.organizationId).select({
    id: webhookAttempt.id, attemptNumber: webhookAttempt.attemptNumber, kind: webhookAttempt.kind,
    attemptedAt: webhookAttempt.attemptedAt, completedAt: webhookAttempt.completedAt,
    responseStatus: webhookAttempt.responseStatus, resultCategory: webhookAttempt.resultCategory,
    outcome: webhookAttempt.outcome, durationMs: webhookAttempt.durationMs,
    nextRetryAt: webhookAttempt.nextRetryAt,
  }).from(webhookAttempt).innerJoin(webhookDelivery, and(
    eq(webhookDelivery.id, webhookAttempt.deliveryId), eq(webhookDelivery.organizationId, webhookAttempt.organizationId),
  )).innerJoin(webhookEndpoint, and(
    eq(webhookEndpoint.id, webhookDelivery.endpointId), eq(webhookEndpoint.organizationId, webhookDelivery.organizationId),
  )).where(and(
    eq(webhookAttempt.organizationId, input.organizationId), eq(webhookAttempt.deliveryId, input.deliveryId),
    eq(webhookEndpoint.environment, input.environment), isNull(webhookEndpoint.deletedAt),
  )).orderBy(desc(webhookAttempt.attemptNumber)).limit(limit);
}
