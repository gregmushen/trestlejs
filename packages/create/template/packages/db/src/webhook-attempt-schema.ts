import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgPolicy, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { webhookDelivery } from "./webhook-projection-schema.js";

/** Durable, tenant-owned attempt metadata. Only local capture retains signed requests. */
export const webhookAttempt = pgTable("webhook_attempt", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  deliveryId: text("delivery_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  kind: text("kind").notNull(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  requestUrl: text("request_url"),
  requestHeaders: jsonb("request_headers").$type<Record<string, string>>().notNull(),
  requestBody: text("request_body"),
  simulatedStatus: integer("simulated_status"),
  responseStatus: integer("response_status"),
  resultCategory: text("result_category"),
  outcome: text("outcome").notNull(),
  durationMs: integer("duration_ms").notNull(),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("webhook_attempt_delivery_number_uidx").on(table.deliveryId, table.attemptNumber),
  index("webhook_attempt_organization_time_idx").on(table.organizationId, table.attemptedAt),
  foreignKey({ columns: [table.deliveryId, table.organizationId], foreignColumns: [webhookDelivery.id, webhookDelivery.organizationId], name: "webhook_attempt_delivery_tenant_fk" }),
  check("webhook_attempt_number_check", sql`${table.attemptNumber} > 0`),
  check("webhook_attempt_kind_check", sql`${table.kind} IN ('local', 'native', 'provider_handoff', 'provider_reported')`),
  check("webhook_attempt_duration_check", sql`${table.durationMs} >= 0`),
  check("webhook_attempt_outcome_check", sql`${table.outcome} IN ('succeeded', 'retry', 'dead', 'exhausted')`),
  check("webhook_attempt_response_status_check", sql`${table.responseStatus} IS NULL OR ${table.responseStatus} BETWEEN 100 AND 599`),
  check("webhook_attempt_result_category_check", sql`${table.resultCategory} IS NULL OR ${table.resultCategory} IN ('http', 'timeout', 'network', 'tls', 'blocked_address')`),
  pgPolicy("webhook_attempt_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
]).enableRLS();
