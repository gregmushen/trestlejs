import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgPolicy, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** Customer-owned destination intent. A row is inert until a later delivery capability activates it. */
export const webhookEndpoint = pgTable("webhook_endpoint", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  environment: text("environment").notNull(),
  name: text("name").notNull(),
  destinationUrl: text("destination_url").notNull(),
  state: text("state").default("disabled").notNull(),
  health: text("health").default("unknown").notNull(),
  provider: text("provider").notNull(),
  createdBy: text("created_by").notNull(),
  updatedBy: text("updated_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("webhook_endpoint_id_organization_uidx").on(table.id, table.organizationId),
  index("webhook_endpoint_organization_idx").on(table.organizationId, table.environment),
  check("webhook_endpoint_state_check", sql`${table.state} IN ('disabled', 'active', 'paused')`),
  check("webhook_endpoint_health_check", sql`${table.health} IN ('unknown', 'healthy', 'degraded', 'failed')`),
  check("webhook_endpoint_provider_check", sql`${table.provider} IN ('local', 'native', 'svix')`),
  pgPolicy("webhook_endpoint_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
]).enableRLS();

/** One row per accepted public event version; provider filters are never authoritative. */
export const webhookSubscription = pgTable("webhook_subscription", {
  organizationId: text("organization_id").notNull(),
  endpointId: uuid("endpoint_id").notNull(),
  publicEventType: text("public_event_type").notNull(),
  publicVersion: integer("public_version").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ name: "webhook_subscription_pk", columns: [table.endpointId, table.publicEventType, table.publicVersion] }),
  foreignKey({ columns: [table.endpointId, table.organizationId], foreignColumns: [webhookEndpoint.id, webhookEndpoint.organizationId], name: "webhook_subscription_endpoint_tenant_fk" }).onDelete("cascade"),
  index("webhook_subscription_organization_event_idx").on(table.organizationId, table.publicEventType, table.publicVersion),
  check("webhook_subscription_version_check", sql`${table.publicVersion} > 0`),
  pgPolicy("webhook_subscription_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
]).enableRLS();
