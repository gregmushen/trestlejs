import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const emailDeliveryEvent = pgTable("email_delivery_event", {
  id: text("id").primaryKey(),
  emailDeliveryId: text("email_delivery_id").notNull(),
  status: text("status").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
});
