import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgPolicy, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { webhookDelivery } from "./webhook-projection-schema.js";

/** A durable, tenant-owned capture of one local delivery attempt. */
export const webhookAttempt = pgTable("webhook_attempt", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  deliveryId: text("delivery_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
  requestUrl: text("request_url").notNull(),
  requestHeaders: jsonb("request_headers").$type<Record<string, string>>().notNull(),
  requestBody: text("request_body").notNull(),
  simulatedStatus: integer("simulated_status"),
  outcome: text("outcome").notNull(),
  durationMs: integer("duration_ms").notNull(),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("webhook_attempt_delivery_number_uidx").on(table.deliveryId, table.attemptNumber),
  index("webhook_attempt_organization_time_idx").on(table.organizationId, table.attemptedAt),
  foreignKey({ columns: [table.deliveryId, table.organizationId], foreignColumns: [webhookDelivery.id, webhookDelivery.organizationId], name: "webhook_attempt_delivery_tenant_fk" }),
  check("webhook_attempt_number_check", sql`${table.attemptNumber} > 0`),
  check("webhook_attempt_duration_check", sql`${table.durationMs} >= 0`),
  check("webhook_attempt_outcome_check", sql`${table.outcome} IN ('succeeded', 'retry', 'dead')`),
  pgPolicy("webhook_attempt_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
]).enableRLS();
