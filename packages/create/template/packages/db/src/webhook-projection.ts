import type { OutboxEntry } from "@__TRESTLE_PROJECT_NAME__/events";
import type { defineEventCatalog } from "@__TRESTLE_PROJECT_NAME__/events";
import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "./index.js";
import { webhookDelivery, webhookMessage } from "./webhook-projection-schema.js";
import { webhookEndpoint, webhookSubscription } from "./webhook-schema.js";

type EventCatalog = ReturnType<typeof defineEventCatalog>;
type CommittedEventStore = { findCommitted(id: string): Promise<OutboxEntry | null> };
export type WebhookProjectionResult =
  | { state: "private" }
  | { state: "ready" | "suppressed"; messageId: string; deliveries: number; created: boolean };

export class WebhookProjectionError extends Error {
  constructor(message: string) { super(message); this.name = "WebhookProjectionError"; }
}

async function stableId(prefix: "whm" | "whd", parts: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join("\0"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `${prefix}_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Used by a post-commit worker. The factory must return a database connection
 * scoped to the organization loaded from the committed outbox row. */
export async function projectCommittedWebhook(input: {
  eventId: string;
  environment: "local" | "preview" | "staging" | "production";
  catalog: EventCatalog;
  outbox: CommittedEventStore;
  tenantDatabase: (organizationId: string) => Database;
  hasEntitlement?: (organizationId: string, entitlement: string) => Promise<boolean>;
  maxPayloadBytes?: number;
  now?: () => Date;
}): Promise<WebhookProjectionResult> {
  const committed = await input.outbox.findCommitted(input.eventId);
  if (!committed) throw new WebhookProjectionError("Committed event was not found");
  const event = committed.message;
  if (event.id !== input.eventId) throw new WebhookProjectionError("Committed event identity is inconsistent");
  const projection = input.catalog.project(event.name, event.schemaVersion, event.payload);
  if (!projection) return { state: "private" };
  if (!committed.organizationId) throw new WebhookProjectionError("Public event has no committed tenant provenance");
  if (projection.resource.type !== event.resource.type || projection.resource.id !== event.resource.id) {
    throw new WebhookProjectionError("Public projection resource differs from the committed event");
  }
  const metadata = input.catalog.publicEvents().find((item) => item.type === projection.type && item.version === projection.version);
  if (!metadata) throw new WebhookProjectionError("Public projection metadata is missing");
  const organizationId = committed.organizationId;
  let entitlementDecision: "not_required" | "allowed" | "denied" = "not_required";
  if (metadata.entitlement) {
    if (!input.hasEntitlement) throw new WebhookProjectionError("Webhook entitlement resolver is required");
    entitlementDecision = await input.hasEntitlement(organizationId, metadata.entitlement) ? "allowed" : "denied";
  }
  const messageId = await stableId("whm", [organizationId, event.id, projection.type, String(projection.version)]);
  const envelope = { id: messageId, type: projection.type, version: projection.version, occurredAt: event.occurredAt, organizationId, resource: projection.resource, data: projection.data };
  const serialized = JSON.stringify(envelope);
  const payloadSize = new TextEncoder().encode(serialized).byteLength;
  const maxPayloadBytes = input.maxPayloadBytes ?? 256 * 1024;
  if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 1 || maxPayloadBytes > 256 * 1024) throw new WebhookProjectionError("Invalid webhook payload limit");
  if (payloadSize > maxPayloadBytes) throw new WebhookProjectionError("Public webhook envelope exceeds the payload limit");
  const now = input.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new WebhookProjectionError("Invalid webhook projection time");

  const database = input.tenantDatabase(organizationId);
  return database.transaction(async (transaction): Promise<WebhookProjectionResult> => {
    const [inserted] = await transaction.insert(webhookMessage).values({
      id: messageId, organizationId, sourceEventId: event.id, publicEventType: projection.type,
      publicVersion: projection.version, occurredAt: new Date(event.occurredAt),
      resourceType: projection.resource.type, resourceId: projection.resource.id,
      envelope: entitlementDecision === "denied" ? null : envelope,
      payloadSize: entitlementDecision === "denied" ? 0 : payloadSize,
      retentionClass: metadata.sensitivity.retentionClass, entitlementDecision,
      status: entitlementDecision === "denied" ? "suppressed" : "ready",
      correlationId: event.correlationId, causationId: event.causationId ?? null,
    }).onConflictDoNothing().returning();
    if (!inserted) {
      const [existing] = await transaction.select({ status: webhookMessage.status }).from(webhookMessage).where(and(eq(webhookMessage.id, messageId), eq(webhookMessage.organizationId, organizationId))).limit(1);
      if (!existing) throw new WebhookProjectionError("Webhook message identity conflict");
      const deliveries = await transaction.select({ id: webhookDelivery.id }).from(webhookDelivery).where(and(eq(webhookDelivery.messageId, messageId), eq(webhookDelivery.organizationId, organizationId)));
      return { state: existing.status === "suppressed" ? "suppressed" : "ready", messageId, deliveries: deliveries.length, created: false };
    }
    if (entitlementDecision === "denied") return { state: "suppressed", messageId, deliveries: 0, created: true };

    const endpoints = await transaction.select({ id: webhookEndpoint.id }).from(webhookEndpoint)
      .innerJoin(webhookSubscription, and(eq(webhookSubscription.endpointId, webhookEndpoint.id), eq(webhookSubscription.organizationId, webhookEndpoint.organizationId)))
      .where(and(eq(webhookEndpoint.organizationId, organizationId), eq(webhookEndpoint.environment, input.environment), eq(webhookEndpoint.state, "active"), isNull(webhookEndpoint.deletedAt), eq(webhookSubscription.publicEventType, projection.type), eq(webhookSubscription.publicVersion, projection.version)));
    for (const endpoint of endpoints) {
      await transaction.insert(webhookDelivery).values({
        id: await stableId("whd", [messageId, endpoint.id]), organizationId,
        messageId, endpointId: endpoint.id, nextAttemptAt: now,
      }).onConflictDoNothing();
    }
    return { state: "ready", messageId, deliveries: endpoints.length, created: true };
  });
}
