import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Internal delivery state. This table is not tenant-readable or client-facing. */
export const outboxMessage = pgTable("outbox_message", {
  id: text("id").primaryKey(),
  eventName: text("event_name").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  correlationId: text("correlation_id").notNull(),
  causationId: text("causation_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
  leasedUntil: timestamp("leased_until", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("outbox_message_idempotency_uidx").on(table.idempotencyKey),
  index("outbox_message_delivery_idx").on(table.status, table.availableAt),
]);

/** Internal consumer receipt state. Retries with the same logical key share one claim. */
export const eventInbox = pgTable("event_inbox", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  eventId: text("event_id").notNull(),
  eventName: text("event_name").notNull(),
  status: text("status").default("processing").notNull(),
  claimToken: text("claim_token"),
  leasedUntil: timestamp("leased_until", { withTimezone: true }),
  attempts: integer("attempts").default(0).notNull(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("event_inbox_event_id_uidx").on(table.eventId),
  index("event_inbox_status_lease_idx").on(table.status, table.leasedUntil),
]);
