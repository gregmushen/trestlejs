import { EVENT_REPLAY_WINDOW_DAYS, type OutboxEntry } from "@__TRESTLE_PROJECT_NAME__/events";
import { and, eq, gte, inArray, lte, notExists, or, sql } from "drizzle-orm";

import { outsideReplayWindow } from "./event-provenance.js";
import type { Database } from "./index.js";
import { outboxMessage } from "./outbox-schema.js";
import { webhookDelivery, webhookMessage } from "./webhook-projection-schema.js";
import { webhookEndpoint } from "./webhook-schema.js";

export type NativeWebhookWakeup = { sourceEventId: string; deliveryId: string };
export type NativeWebhookWork =
  | { state: "not_found" | "not_native" | "inactive" }
  | { state: "ready" | "expired"; organizationId: string; deliveryId: string };

/** Queue work contains identifiers only. In particular, a supplied tenant ID
 * must not become authority for the subsequent tenant-scoped database query. */
export function parseNativeWebhookWakeup(value: unknown): NativeWebhookWakeup {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native webhook wake-up");
  const work = value as Record<string, unknown>;
  if (Object.keys(work).length !== 2 || typeof work.sourceEventId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(work.sourceEventId)
    || typeof work.deliveryId !== "string" || !/^whd_(?:[0-9a-f]{64}|replay_[0-9a-f]{32})$/u.test(work.deliveryId)) {
    throw new Error("Invalid native webhook wake-up");
  }
  return { sourceEventId: work.sourceEventId, deliveryId: work.deliveryId };
}

/** Resolve Queue identity through the committed outbox row, then verify the
 * projected delivery under that row's tenant RLS context. This is a read-only
 * boundary; duplicate or delayed wake-ups are fenced by the later claim.
 * A committed event older than the 14-day replay window resolves as
 * `expired`; the caller settles that delivery with `expireNativeWebhookDelivery`. */
export async function resolveNativeWebhookWork(input: {
  wakeup: unknown;
  environment: "preview" | "staging" | "production";
  outbox: { findCommitted(id: string): Promise<OutboxEntry | null> };
  tenantDatabase: (organizationId: string) => Database;
  now?: Date;
}): Promise<NativeWebhookWork> {
  const wakeup = parseNativeWebhookWakeup(input.wakeup);
  const committed = await input.outbox.findCommitted(wakeup.sourceEventId);
  if (!committed?.organizationId || committed.id !== wakeup.sourceEventId || committed.message.id !== wakeup.sourceEventId) return { state: "not_found" };
  const organizationId = committed.organizationId;
  const database = input.tenantDatabase(organizationId);
  const [record] = await database.select({
    sourceEventId: webhookMessage.sourceEventId,
    messageStatus: webhookMessage.status,
    provider: webhookEndpoint.provider,
    environment: webhookEndpoint.environment,
    endpointState: webhookEndpoint.state,
    deletedAt: webhookEndpoint.deletedAt,
  }).from(webhookDelivery)
    .innerJoin(webhookMessage, and(eq(webhookMessage.id, webhookDelivery.messageId), eq(webhookMessage.organizationId, webhookDelivery.organizationId)))
    .innerJoin(webhookEndpoint, and(eq(webhookEndpoint.id, webhookDelivery.endpointId), eq(webhookEndpoint.organizationId, webhookDelivery.organizationId)))
    .where(and(eq(webhookDelivery.id, wakeup.deliveryId), eq(webhookDelivery.organizationId, organizationId)))
    .limit(1);
  if (!record || record.sourceEventId !== wakeup.sourceEventId) return { state: "not_found" };
  if (record.provider !== "native" || record.environment !== input.environment) return { state: "not_native" };
  if (outsideReplayWindow(committed.message.occurredAt, input.now ?? new Date())) return { state: "expired", organizationId, deliveryId: wakeup.deliveryId };
  if (record.messageStatus !== "ready" || record.endpointState !== "active" || record.deletedAt) return { state: "inactive" };
  return { state: "ready", organizationId, deliveryId: wakeup.deliveryId };
}

const expiredDelivery = (now: Date) => ({
  state: "exhausted", terminalReason: "provenance_expired", completedAt: now,
  nextAttemptAt: null, leaseToken: null, leasedUntil: null,
});
/** Pending or retrying, or leased with a lease that has run out. */
const settleable = (now: Date) => or(
  inArray(webhookDelivery.state, ["pending", "retry"]),
  and(eq(webhookDelivery.state, "leased"), lte(webhookDelivery.leasedUntil, now)),
);

function validNow(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invalid webhook provenance clock");
  return now;
}

/** Settle one delivery whose committed source event is past the replay window
 * as `exhausted` (`provenance_expired`), so it never waits in retry for work
 * that verification will always refuse. A live lease is left to its attempt.
 * Returns whether the delivery was settled. */
export async function expireNativeWebhookDelivery(input: {
  organizationId: string;
  deliveryId: string;
  tenantDatabase: (organizationId: string) => Database;
  now: Date;
}): Promise<boolean> {
  const now = validNow(input.now);
  const rows = await input.tenantDatabase(input.organizationId).update(webhookDelivery).set(expiredDelivery(now))
    .where(and(eq(webhookDelivery.id, input.deliveryId), eq(webhookDelivery.organizationId, input.organizationId), settleable(now)))
    .returning();
  return rows.length > 0;
}

/** For one tenant, settle unfinished native deliveries whose committed source
 * event was pruned, belongs to another tenant, or is past the replay window.
 * A Queue wake-up for such a delivery cannot recover its tenant, so recovery,
 * which already runs per organization, settles it here. Bounded per call. */
export async function expireUnprovenNativeWebhookDeliveries(input: {
  organizationId: string;
  environment: "preview" | "staging" | "production";
  tenantDatabase: (organizationId: string) => Database;
  now: Date;
  limit?: number;
}): Promise<number> {
  const now = validNow(input.now);
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Invalid webhook provenance page size");
  const database = input.tenantDatabase(input.organizationId);
  const windowStart = new Date(now.getTime() - EVENT_REPLAY_WINDOW_DAYS * 86_400_000);
  const unproven = database.select({ id: webhookDelivery.id }).from(webhookDelivery)
    .innerJoin(webhookMessage, and(eq(webhookMessage.id, webhookDelivery.messageId), eq(webhookMessage.organizationId, webhookDelivery.organizationId)))
    .innerJoin(webhookEndpoint, and(eq(webhookEndpoint.id, webhookDelivery.endpointId), eq(webhookEndpoint.organizationId, webhookDelivery.organizationId)))
    .where(and(
      eq(webhookDelivery.organizationId, input.organizationId), settleable(now),
      eq(webhookEndpoint.provider, "native"), eq(webhookEndpoint.environment, input.environment),
      notExists(database.select({ id: outboxMessage.id }).from(outboxMessage).where(and(
        eq(outboxMessage.id, sql`${webhookMessage.sourceEventId}::text`),
        eq(outboxMessage.organizationId, input.organizationId),
        gte(outboxMessage.occurredAt, windowStart),
      ))),
    )).limit(limit);
  const rows = await database.update(webhookDelivery).set(expiredDelivery(now))
    .where(and(eq(webhookDelivery.organizationId, input.organizationId), inArray(webhookDelivery.id, unproven), settleable(now)))
    .returning();
  return rows.length;
}
