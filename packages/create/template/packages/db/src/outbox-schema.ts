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
