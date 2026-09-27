import { sql } from "drizzle-orm";
import { check, index, pgPolicy, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const emailDeliveryEvent = pgTable("email_delivery_event", {
  id: text("id").primaryKey(),
  emailDeliveryId: text("email_delivery_id").notNull(),
  status: text("status").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  /** The sending organization from the verified Resend tag; null for untagged email. */
  organizationId: text("organization_id"),
  /** The provider's bounce classification (for example Permanent / Suppressed); never the message. */
  bounceType: text("bounce_type"),
  bounceSubType: text("bounce_sub_type"),
}, (table) => [index("email_delivery_event_received_idx").on(table.receivedAt)]);

/**
 * Addresses an organization must not email again. Hard bounces and complaints
 * are recorded from verified Resend webhooks; unsubscribes by the application.
 * `address` is normalized to lowercase; `source_event_id` is the provider event.
 */
export const emailSuppression = pgTable("email_suppression", {
  organizationId: text("organization_id").notNull(),
  address: text("address").notNull(),
  reason: text("reason").notNull(),
  sourceEventId: text("source_event_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("email_suppression_organization_address_uidx").on(table.organizationId, table.address),
  check("email_suppression_reason_check", sql`${table.reason} IN ('unsubscribed', 'bounced', 'complained')`),
  check("email_suppression_address_check", sql`${table.address} = lower(${table.address})`),
  pgPolicy("email_suppression_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
  pgPolicy("email_suppression_platform_select", { for: "select", to: "trestle_platform", using: sql`true` }),
  // Operators remove a suppression with a reason; the audit event commits in the same transaction.
  pgPolicy("email_suppression_platform_delete", { for: "delete", to: "trestle_platform", using: sql`true` }),
]).enableRLS();
