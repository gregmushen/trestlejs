import { and, eq, inArray, sql } from "drizzle-orm";

import { recordAuditEvent } from "./audit.js";
import { outsideReplayWindow } from "./event-provenance.js";
import type { Database } from "./index.js";
import { outboxMessage } from "./outbox-schema.js";
import { webhookDelivery, webhookMessage } from "./webhook-projection-schema.js";
import { webhookEndpoint } from "./webhook-schema.js";

export type TenantWebhookReplayResult =
  | { state: "created" | "existing"; deliveryId: string }
  | { state: "not_found" | "not_terminal" | "payload_gone" | "endpoint_inactive" | "already_succeeded" | "provenance_expired" };

/** Queue a new execution of a retained public message under forced tenant RLS.
 * The original terminal delivery and its attempts are never rewritten.
 * A delivery reverifies its committed source event, so a replay is refused
 * (`provenance_expired`) once that outbox row is pruned, belongs to another
 * tenant, or is older than the 14-day replay window. */
export async function replayTenantWebhookDelivery(input: {
  organizationId: string;
  environment: "local" | "preview" | "staging" | "production";
  deliveryId: string;
  actorId: string;
  correlationId: string;
  database: Database;
  now: Date;
}): Promise<TenantWebhookReplayResult> {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) throw new Error("Invalid webhook replay time");
  if (!input.actorId.trim() || !input.correlationId.trim()) throw new Error("Webhook replay requires an actor and correlation ID");
  return input.database.transaction(async (transaction): Promise<TenantWebhookReplayResult> => {
    const [reference] = await transaction.select({ rootId: webhookDelivery.replayOfDeliveryId }).from(webhookDelivery)
      .where(and(eq(webhookDelivery.id, input.deliveryId), eq(webhookDelivery.organizationId, input.organizationId))).limit(1);
    if (!reference) return { state: "not_found" };
    const rootId = reference.rootId ?? input.deliveryId;
    // All replays of one original serialize on its row, including requests
    // naming an already-failed replay rather than the original delivery.
    const [root] = await transaction.select({ id: webhookDelivery.id }).from(webhookDelivery)
      .where(and(eq(webhookDelivery.id, rootId), eq(webhookDelivery.organizationId, input.organizationId)))
      .for("update").limit(1);
    if (!root) return { state: "not_found" };
    const [source] = await transaction.select({
      state: webhookDelivery.state, attemptCount: webhookDelivery.attemptCount,
      messageId: webhookDelivery.messageId, endpointId: webhookDelivery.endpointId,
      sourceEventId: webhookMessage.sourceEventId, messageStatus: webhookMessage.status, payloadDeletedAt: webhookMessage.payloadDeletedAt,
      payloadPresent: sql<boolean>`${webhookMessage.envelope} IS NOT NULL`,
      endpointState: webhookEndpoint.state, endpointDeletedAt: webhookEndpoint.deletedAt,
      provider: webhookEndpoint.provider,
    }).from(webhookDelivery)
      .innerJoin(webhookMessage, and(eq(webhookMessage.id, webhookDelivery.messageId), eq(webhookMessage.organizationId, webhookDelivery.organizationId)))
      .innerJoin(webhookEndpoint, and(eq(webhookEndpoint.id, webhookDelivery.endpointId), eq(webhookEndpoint.organizationId, webhookDelivery.organizationId)))
      .where(and(eq(webhookDelivery.id, input.deliveryId), eq(webhookDelivery.organizationId, input.organizationId), eq(webhookEndpoint.environment, input.environment)))
      .limit(1);
    if (!source) return { state: "not_found" };
    if (source.state !== "dead" && source.state !== "exhausted") return { state: "not_terminal" };
    if (source.messageStatus !== "ready" || source.payloadDeletedAt || !source.payloadPresent) return { state: "payload_gone" };
    if ((input.environment === "local" && source.provider !== "local") || (input.environment !== "local" && source.provider !== "native")) return { state: "endpoint_inactive" };
    if (source.endpointState !== "active" || source.endpointDeletedAt) return { state: "endpoint_inactive" };
    const [succeeded] = await transaction.select({ id: webhookDelivery.id }).from(webhookDelivery)
      .where(and(eq(webhookDelivery.organizationId, input.organizationId), eq(webhookDelivery.replayOfDeliveryId, rootId), eq(webhookDelivery.state, "succeeded"))).limit(1);
    if (succeeded) return { state: "already_succeeded" };
    const [active] = await transaction.select({ id: webhookDelivery.id }).from(webhookDelivery)
      .where(and(eq(webhookDelivery.organizationId, input.organizationId), eq(webhookDelivery.replayOfDeliveryId, rootId), inArray(webhookDelivery.state, ["pending", "leased", "retry"]))).limit(1);
    if (active) return { state: "existing", deliveryId: active.id };
    // FOR SHARE holds the provenance until this transaction commits; after
    // that the new non-terminal delivery keeps it from being pruned.
    const [provenance] = await transaction.select({ occurredAt: outboxMessage.occurredAt }).from(outboxMessage)
      .where(and(eq(outboxMessage.id, source.sourceEventId), eq(outboxMessage.organizationId, input.organizationId)))
      .for("share").limit(1);
    if (!provenance || outsideReplayWindow(provenance.occurredAt, input.now)) return { state: "provenance_expired" };
    const deliveryId = `whd_replay_${crypto.randomUUID().replaceAll("-", "")}`;
    await transaction.insert(webhookDelivery).values({
      id: deliveryId, organizationId: input.organizationId, messageId: source.messageId,
      endpointId: source.endpointId, replayOfDeliveryId: rootId, state: "pending", nextAttemptAt: input.now, createdAt: input.now,
    });
    await recordAuditEvent(transaction, {
      name: "webhooks.delivery.replayed", actor: { type: "user", id: input.actorId }, organizationId: input.organizationId,
      target: { type: "webhook_delivery", id: deliveryId },
      summary: { sourceDeliveryId: input.deliveryId, previousState: source.state, previousAttemptCount: source.attemptCount },
      environment: input.environment, correlationId: input.correlationId, occurredAt: input.now,
    });
    return { state: "created", deliveryId };
  });
}
