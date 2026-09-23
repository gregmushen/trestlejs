import { and, asc, count, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { artifactMetadata } from "./artifact-schema.js";
import { recordAuditEvent } from "./audit.js";
import type { Database } from "./index.js";
import { outboxMessage } from "./outbox-schema.js";
import type { PlatformChangeContext } from "./platform-roles.js";
import { webhookDelivery, webhookMessage } from "./webhook-projection-schema.js";
import { webhookEndpoint } from "./webhook-schema.js";

/**
 * Platform operations over main's async, webhook, and artifact subsystems.
 * Every function runs on the trestle_platform connection, whose column grants
 * exclude payloads, envelopes, destinations, lease tokens, and storage keys, and
 * whose RLS policies allow only the transitions below: dead outbox → pending,
 * endpoint → disabled, and dead/exhausted delivery → retry. Each action records a
 * redacted audit_event in the same transaction.
 */
export class PlatformOperationError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "conflict", message: string) {
    super(message);
    this.name = "PlatformOperationError";
  }
}

function requireReason(reason: string): string {
  const text = reason.trim();
  if (!text || text.length > 500) throw new PlatformOperationError("invalid", "A reason of at most 500 characters is required");
  return text;
}

function pageSize(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(Number.isFinite(limit) ? limit! : 50), 1), 100);
}

const auditContext = (context: PlatformChangeContext) => ({ actor: context.actor, environment: context.environment, correlationId: context.correlationId, ...(context.now ? { occurredAt: context.now } : {}) });

export type DeadOutboxEvent = Readonly<{ id: string; eventName: string; organizationId: string | null; correlationId: string; attempts: number; lastError: string | null; createdAt: Date }>;

/** Dead-lettered outbox events, oldest first. Payloads are never selected or granted. */
export async function listDeadOutboxEvents(database: Database, options: Readonly<{ limit?: number }> = {}): Promise<DeadOutboxEvent[]> {
  return await database.select({
    id: outboxMessage.id, eventName: outboxMessage.eventName, organizationId: outboxMessage.organizationId, correlationId: outboxMessage.correlationId,
    attempts: outboxMessage.attempts, lastError: outboxMessage.lastError, createdAt: outboxMessage.createdAt,
  }).from(outboxMessage).where(eq(outboxMessage.status, "dead")).orderBy(asc(outboxMessage.availableAt), asc(outboxMessage.id)).limit(pageSize(options.limit));
}

/** Returns one dead outbox event to pending, as `trestle queue dlq redrive` does, and audits it. */
export async function redriveOutboxEvent(database: Database, id: string, context: PlatformChangeContext): Promise<void> {
  const reason = requireReason(context.reason);
  await database.transaction(async (transaction) => {
    // Column grants exclude payloads, so lock and read only the audited fields before the transition.
    const [row] = await transaction.select({ id: outboxMessage.id, eventName: outboxMessage.eventName, organizationId: outboxMessage.organizationId, attempts: outboxMessage.attempts })
      .from(outboxMessage).where(and(eq(outboxMessage.id, id), eq(outboxMessage.status, "dead"))).for("update").limit(1);
    if (!row) throw new PlatformOperationError("not_found", "The outbox event is not dead-lettered");
    await transaction.update(outboxMessage).set({ status: "pending", availableAt: sql`now()`, leasedUntil: null, lastError: null })
      .where(and(eq(outboxMessage.id, id), eq(outboxMessage.status, "dead")));
    await recordAuditEvent(transaction, {
      ...auditContext(context), name: "platform.outbox_event.redriven", organizationId: row.organizationId, target: { type: "outbox_message", id: row.id },
      reason, summary: { eventName: row.eventName, attempts: row.attempts },
    });
  });
}

export type PlatformWebhookEndpoint = Readonly<{ id: string; organizationId: string; environment: string; name: string; state: string; health: string; provider: string; updatedAt: Date }>;

/** Webhook endpoints across organizations, without destinations or secrets. */
export async function listPlatformWebhookEndpoints(database: Database, options: Readonly<{ state?: "active" | "disabled" | "paused"; limit?: number }> = {}): Promise<PlatformWebhookEndpoint[]> {
  return await database.select({
    id: webhookEndpoint.id, organizationId: webhookEndpoint.organizationId, environment: webhookEndpoint.environment, name: webhookEndpoint.name,
    state: webhookEndpoint.state, health: webhookEndpoint.health, provider: webhookEndpoint.provider, updatedAt: webhookEndpoint.updatedAt,
  }).from(webhookEndpoint)
    .where(options.state ? and(isNull(webhookEndpoint.deletedAt), eq(webhookEndpoint.state, options.state)) : isNull(webhookEndpoint.deletedAt))
    .orderBy(desc(webhookEndpoint.updatedAt), asc(webhookEndpoint.id)).limit(pageSize(options.limit));
}

/** Disables an endpoint, for example one that is failing or abusive, and audits it on the owning organization. */
export async function disableWebhookEndpoint(database: Database, input: Readonly<{ organizationId: string; endpointId: string }>, context: PlatformChangeContext): Promise<void> {
  const reason = requireReason(context.reason);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.endpointId)) throw new PlatformOperationError("not_found", "The webhook endpoint does not exist");
  await database.transaction(async (transaction) => {
    const [endpoint] = await transaction.select({ state: webhookEndpoint.state }).from(webhookEndpoint)
      .where(and(eq(webhookEndpoint.id, input.endpointId), eq(webhookEndpoint.organizationId, input.organizationId), isNull(webhookEndpoint.deletedAt))).for("update").limit(1);
    if (!endpoint) throw new PlatformOperationError("not_found", "The webhook endpoint does not exist");
    if (endpoint.state === "disabled") throw new PlatformOperationError("conflict", "The webhook endpoint is already disabled");
    await transaction.update(webhookEndpoint).set({ state: "disabled", updatedAt: context.now ?? new Date(), updatedBy: `${context.actor.type}:${context.actor.id}` })
      .where(and(eq(webhookEndpoint.id, input.endpointId), eq(webhookEndpoint.organizationId, input.organizationId)));
    await recordAuditEvent(transaction, {
      ...auditContext(context), name: "platform.webhook_endpoint.disabled", organizationId: input.organizationId, target: { type: "webhook_endpoint", id: input.endpointId },
      reason, summary: { previousState: endpoint.state },
    });
  });
}

export type FailedWebhookDelivery = Readonly<{ id: string; organizationId: string; endpointId: string; eventType: string; state: string; attemptCount: number; terminalReason: string | null; completedAt: Date | null; replayable: boolean }>;

/** Dead and exhausted deliveries, newest first. A delivery is replayable while its message payload is retained. */
export async function listFailedWebhookDeliveries(database: Database, options: Readonly<{ limit?: number }> = {}): Promise<FailedWebhookDelivery[]> {
  const rows = await database.select({
    id: webhookDelivery.id, organizationId: webhookDelivery.organizationId, endpointId: webhookDelivery.endpointId, eventType: webhookMessage.publicEventType,
    state: webhookDelivery.state, attemptCount: webhookDelivery.attemptCount, terminalReason: webhookDelivery.terminalReason, completedAt: webhookDelivery.completedAt,
    messageStatus: webhookMessage.status, payloadDeletedAt: webhookMessage.payloadDeletedAt,
  }).from(webhookDelivery)
    .innerJoin(webhookMessage, and(eq(webhookMessage.id, webhookDelivery.messageId), eq(webhookMessage.organizationId, webhookDelivery.organizationId)))
    .where(inArray(webhookDelivery.state, ["dead", "exhausted"]))
    .orderBy(desc(webhookDelivery.completedAt), asc(webhookDelivery.id)).limit(pageSize(options.limit));
  return rows.map(({ messageStatus, payloadDeletedAt, ...row }) => ({ ...row, replayable: messageStatus === "ready" && payloadDeletedAt === null }));
}

/**
 * Replays a dead or exhausted delivery: it returns to `retry`, due now, and the
 * native delivery sweep claims it on its next pass. Attempt history is kept, so the
 * replay is one more attempt in the same sequence rather than a fresh schedule.
 */
export async function replayWebhookDelivery(database: Database, input: Readonly<{ organizationId: string; deliveryId: string }>, context: PlatformChangeContext): Promise<void> {
  const reason = requireReason(context.reason);
  await database.transaction(async (transaction) => {
    const [delivery] = await transaction.select({ state: webhookDelivery.state, attemptCount: webhookDelivery.attemptCount, messageStatus: webhookMessage.status, payloadDeletedAt: webhookMessage.payloadDeletedAt })
      .from(webhookDelivery)
      .innerJoin(webhookMessage, and(eq(webhookMessage.id, webhookDelivery.messageId), eq(webhookMessage.organizationId, webhookDelivery.organizationId)))
      .where(and(eq(webhookDelivery.id, input.deliveryId), eq(webhookDelivery.organizationId, input.organizationId))).for("update", { of: webhookDelivery }).limit(1);
    if (!delivery) throw new PlatformOperationError("not_found", "The webhook delivery does not exist");
    if (delivery.state !== "dead" && delivery.state !== "exhausted") throw new PlatformOperationError("conflict", `A ${delivery.state} delivery cannot be replayed`);
    if (delivery.messageStatus !== "ready" || delivery.payloadDeletedAt !== null) throw new PlatformOperationError("conflict", "The event payload is no longer retained, so the delivery cannot be replayed");
    await transaction.update(webhookDelivery).set({ state: "retry", nextAttemptAt: context.now ?? sql`now()`, terminalReason: null, completedAt: null })
      .where(and(eq(webhookDelivery.id, input.deliveryId), eq(webhookDelivery.organizationId, input.organizationId), inArray(webhookDelivery.state, ["dead", "exhausted"])));
    await recordAuditEvent(transaction, {
      ...auditContext(context), name: "platform.webhook_delivery.replayed", organizationId: input.organizationId, target: { type: "webhook_delivery", id: input.deliveryId },
      reason, summary: { previousState: delivery.state, attemptCount: delivery.attemptCount },
    });
  });
}

export type ArtifactOperations = Readonly<{ states: Record<"pending" | "ready" | "cleaning" | "deleted", { count: number; bytes: number }>; stalePending: number }>;

/** Artifact lifecycle totals across organizations; storage keys are never granted. */
export async function artifactOperations(database: Database, options: Readonly<{ staleBefore: Date }>): Promise<ArtifactOperations> {
  const rows = await database.select({ state: artifactMetadata.uploadState, total: count(artifactMetadata.id), bytes: sql<string>`coalesce(sum(${artifactMetadata.size}), 0)::text` })
    .from(artifactMetadata).groupBy(artifactMetadata.uploadState);
  const [stale] = await database.select({ total: count(artifactMetadata.id) }).from(artifactMetadata)
    .where(and(eq(artifactMetadata.uploadState, "pending"), lt(artifactMetadata.createdAt, options.staleBefore)));
  const states = { pending: { count: 0, bytes: 0 }, ready: { count: 0, bytes: 0 }, cleaning: { count: 0, bytes: 0 }, deleted: { count: 0, bytes: 0 } };
  for (const row of rows) if (row.state in states) states[row.state as keyof typeof states] = { count: Number(row.total), bytes: Number(row.bytes) };
  return { states, stalePending: Number(stale?.total ?? 0) };
}
