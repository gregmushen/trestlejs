import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { outsideReplayWindow } from "./event-provenance.js";
import type { Database } from "./index.js";
import { outboxMessage } from "./outbox-schema.js";
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

/** A failed delivery is replayable only while its payload is retained and its
 * source event is inside the 14-day replay window at `now` (default: the
 * current time). The source event's age decides eligibility but is not
 * returned; replayTenantWebhookDelivery remains the authority. */
export async function listWebhookDeliveries(input: {
  organizationId: string;
  environment: "local" | "preview" | "staging" | "production";
  endpointId: string;
  tenantDatabase: (organizationId: string) => Database;
  limit?: number;
  deliveryMode?: "disabled" | "local" | "native" | "svix";
  now?: Date;
}) {
  const limit = inspectionLimit(input.limit ?? 50);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid webhook replay eligibility time");
  const rows = await input.tenantDatabase(input.organizationId).select({
    id: webhookDelivery.id, messageId: webhookMessage.id, eventType: webhookMessage.publicEventType,
    eventVersion: webhookMessage.publicVersion, occurredAt: webhookMessage.occurredAt,
    state: webhookDelivery.state, attemptCount: webhookDelivery.attemptCount,
    replayOfDeliveryId: webhookDelivery.replayOfDeliveryId,
    activeReplayId: sql<string | null>`(select replay.id from webhook_delivery replay where replay.organization_id = ${input.organizationId} and replay.replay_of_delivery_id = coalesce(${webhookDelivery.replayOfDeliveryId}, ${webhookDelivery.id}) and replay.state in ('pending', 'leased', 'retry') limit 1)`,
    successfulReplayId: sql<string | null>`(select replay.id from webhook_delivery replay where replay.organization_id = ${input.organizationId} and replay.replay_of_delivery_id = coalesce(${webhookDelivery.replayOfDeliveryId}, ${webhookDelivery.id}) and replay.state = 'succeeded' limit 1)`,
    nextAttemptAt: webhookDelivery.nextAttemptAt, terminalReason: webhookDelivery.terminalReason,
    createdAt: webhookDelivery.createdAt, completedAt: webhookDelivery.completedAt,
    payloadDeletedAt: webhookMessage.payloadDeletedAt, messageStatus: webhookMessage.status,
    payloadPresent: sql<boolean>`${webhookMessage.envelope} IS NOT NULL`,
    endpointState: webhookEndpoint.state, endpointProvider: webhookEndpoint.provider,
    correlationId: webhookMessage.correlationId,
    sourceOccurredAt: sql<Date | null>`(select source.occurred_at from outbox_message source where source.id = ${webhookMessage.sourceEventId}::text and source.organization_id = ${input.organizationId})`.mapWith(outboxMessage.occurredAt),
  }).from(webhookDelivery)
    .innerJoin(webhookMessage, and(eq(webhookMessage.id, webhookDelivery.messageId), eq(webhookMessage.organizationId, webhookDelivery.organizationId)))
    .innerJoin(webhookEndpoint, and(eq(webhookEndpoint.id, webhookDelivery.endpointId), eq(webhookEndpoint.organizationId, webhookDelivery.organizationId)))
    .where(and(
      eq(webhookDelivery.organizationId, input.organizationId), eq(webhookDelivery.endpointId, input.endpointId),
      eq(webhookEndpoint.environment, input.environment), isNull(webhookEndpoint.deletedAt),
    )).orderBy(desc(webhookDelivery.createdAt), desc(webhookDelivery.id)).limit(limit);
  return rows.map(({ payloadDeletedAt, messageStatus, payloadPresent, endpointState, endpointProvider, sourceOccurredAt, ...row }) => {
    const payloadAvailable = !payloadDeletedAt && messageStatus === "ready" && payloadPresent;
    const expectedMode = input.environment === "local" ? "local" : "native";
    const providerReady = endpointProvider === expectedMode && (input.deliveryMode === undefined || input.deliveryMode === expectedMode);
    const replayUnavailableReason = row.state !== "dead" && row.state !== "exhausted" ? "not_failed"
      : !payloadAvailable ? "payload_expired"
      : row.successfulReplayId ? "resolved"
      : endpointState !== "active" ? "endpoint_inactive"
      : !providerReady ? "provider_unavailable"
      : row.activeReplayId ? "replay_pending"
      : sourceOccurredAt === null || outsideReplayWindow(sourceOccurredAt, now) ? "provenance_expired" : null;
    return { ...row, payloadAvailable, replayable: replayUnavailableReason === null, replayUnavailableReason };
  });
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
