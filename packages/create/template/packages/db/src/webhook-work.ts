import type { OutboxEntry } from "@__TRESTLE_PROJECT_NAME__/events";
import { and, eq } from "drizzle-orm";

import type { Database } from "./index.js";
import { webhookDelivery, webhookMessage } from "./webhook-projection-schema.js";
import { webhookEndpoint } from "./webhook-schema.js";

export type NativeWebhookWakeup = { sourceEventId: string; deliveryId: string };
export type NativeWebhookWork =
  | { state: "not_found" | "not_native" | "inactive" }
  | { state: "ready"; organizationId: string; deliveryId: string };

/** Queue work contains identifiers only. In particular, a supplied tenant ID
 * must not become authority for the subsequent tenant-scoped database query. */
export function parseNativeWebhookWakeup(value: unknown): NativeWebhookWakeup {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native webhook wake-up");
  const work = value as Record<string, unknown>;
  if (Object.keys(work).length !== 2 || typeof work.sourceEventId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(work.sourceEventId)
    || typeof work.deliveryId !== "string" || !/^whd_[0-9a-f]{64}$/u.test(work.deliveryId)) {
    throw new Error("Invalid native webhook wake-up");
  }
  return { sourceEventId: work.sourceEventId, deliveryId: work.deliveryId };
}

/** Resolve Queue identity through the committed outbox row, then verify the
 * projected delivery under that row's tenant RLS context. This is a read-only
 * boundary; duplicate or delayed wake-ups are fenced by the later claim. */
export async function resolveNativeWebhookWork(input: {
  wakeup: unknown;
  environment: "preview" | "staging" | "production";
  outbox: { findCommitted(id: string): Promise<OutboxEntry | null> };
  tenantDatabase: (organizationId: string) => Database;
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
  if (record.messageStatus !== "ready" || record.endpointState !== "active" || record.deletedAt) return { state: "inactive" };
  return { state: "ready", organizationId, deliveryId: wakeup.deliveryId };
}
