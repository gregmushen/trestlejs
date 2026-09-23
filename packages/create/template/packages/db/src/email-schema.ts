import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const emailDeliveryEvent = pgTable("email_delivery_event", {
  id: text("id").primaryKey(),
  emailDeliveryId: text("email_delivery_id").notNull(),
  status: text("status").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * One row per send, written by the recording email service. It holds only the
 * template id, a masked recipient, and delivery metadata, never content.
 */
export const emailDelivery = pgTable("email_delivery", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  template: text("template").notNull(),
  recipientMasked: text("recipient_masked").notNull(),
  recipientCount: integer("recipient_count").default(1).notNull(),
  status: text("status").notNull(),
  failureCategory: text("failure_category"),
  correlationId: text("correlation_id"),
  organizationId: text("organization_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
