import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { webhookEndpoint } from "./webhook-schema.js";

/** Immutable public projection of one committed application event. */
export const webhookMessage = pgTable("webhook_message", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  sourceEventId: uuid("source_event_id").notNull(),
  publicEventType: text("public_event_type").notNull(),
  publicVersion: integer("public_version").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  envelope: jsonb("envelope"),
  payloadSize: integer("payload_size").notNull(),
  retentionClass: text("retention_class").notNull(),
  entitlementDecision: text("entitlement_decision").notNull(),
  status: text("status").notNull(),
  correlationId: text("correlation_id").notNull(),
  causationId: text("causation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  payloadDeletedAt: timestamp("payload_deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("webhook_message_id_organization_uidx").on(table.id, table.organizationId),
  uniqueIndex("webhook_message_source_projection_uidx").on(table.organizationId, table.sourceEventId, table.publicEventType, table.publicVersion),
  index("webhook_message_organization_created_idx").on(table.organizationId, table.createdAt),
  check("webhook_message_version_check", sql`${table.publicVersion} > 0`),
  check("webhook_message_retention_check", sql`${table.retentionClass} IN ('standard', 'short')`),
  check("webhook_message_entitlement_check", sql`${table.entitlementDecision} IN ('not_required', 'allowed', 'denied')`),
  check("webhook_message_status_check", sql`${table.status} IN ('ready', 'suppressed')`),
  pgPolicy("webhook_message_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
  // Platform reads are limited by column grants to metadata; envelopes are never granted.
  pgPolicy("webhook_message_platform_select", { for: "select", to: "trestle_platform", using: sql`true` }),
]).enableRLS();

/** One logical endpoint delivery; attempts and transport remain separate. */
export const webhookDelivery = pgTable("webhook_delivery", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  messageId: text("message_id").notNull(),
  endpointId: uuid("endpoint_id").notNull(),
  state: text("state").default("pending").notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  leaseToken: uuid("lease_token"),
  leasedUntil: timestamp("leased_until", { withTimezone: true }),
  attemptCount: integer("attempt_count").default(0).notNull(),
  terminalReason: text("terminal_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("webhook_delivery_id_organization_uidx").on(table.id, table.organizationId),
  uniqueIndex("webhook_delivery_message_endpoint_uidx").on(table.messageId, table.endpointId),
  index("webhook_delivery_organization_state_idx").on(table.organizationId, table.state, table.nextAttemptAt),
  index("webhook_delivery_lease_recovery_idx").on(table.state, table.leasedUntil),
  foreignKey({ columns: [table.messageId, table.organizationId], foreignColumns: [webhookMessage.id, webhookMessage.organizationId], name: "webhook_delivery_message_tenant_fk" }),
  foreignKey({ columns: [table.endpointId, table.organizationId], foreignColumns: [webhookEndpoint.id, webhookEndpoint.organizationId], name: "webhook_delivery_endpoint_tenant_fk" }),
  check("webhook_delivery_state_check", sql`${table.state} IN ('pending', 'leased', 'retry', 'succeeded', 'dead', 'exhausted')`),
  check("webhook_delivery_lease_pair_check", sql`(${table.state} = 'leased' AND ${table.leaseToken} IS NOT NULL AND ${table.leasedUntil} IS NOT NULL) OR (${table.state} <> 'leased' AND ${table.leaseToken} IS NULL AND ${table.leasedUntil} IS NULL)`),
  pgPolicy("webhook_delivery_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
  // The platform admin may only move a dead or exhausted delivery back to retry.
  pgPolicy("webhook_delivery_platform_select", { for: "select", to: "trestle_platform", using: sql`true` }),
  pgPolicy("webhook_delivery_platform_replay", { for: "update", to: "trestle_platform", using: sql`${table.state} IN ('dead', 'exhausted')`, withCheck: sql`${table.state} = 'retry'` }),
]).enableRLS();
