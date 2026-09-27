import { sql } from "drizzle-orm";
import { check, index, integer, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * A tenant's binding to one external account, held by a connection backend
 * (Nango first). Trestle owns the tenant binding, lifecycle state, generation,
 * and attribution; the backend holds the credential. The credential reference
 * is only (backend, provider config key, backend connection ID): no provider
 * token is ever a column.
 */
export const integrationConnection = pgTable("integration_connection", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  environment: text("environment").notNull(),
  backend: text("backend").notNull(),
  /** The backend's integration key (Nango: provider config key). */
  providerConfigKey: text("provider_config_key").notNull(),
  backendConnectionId: text("backend_connection_id").notNull(),
  /** The provider the backend reports, e.g. `github`; an observation, not authority. */
  provider: text("provider"),
  state: text("state").notNull(),
  /** Incremented by each reconnect; work re-reads it before every external attempt. */
  generation: integer("generation").default(1).notNull(),
  /** The backend credential could not be deleted on disconnect; reconciliation retries it. */
  cleanupPending: text("cleanup_pending"),
  createdBy: text("created_by").notNull(),
  updatedBy: text("updated_by").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  // One backend connection belongs to exactly one tenant Connection, across all tenants.
  uniqueIndex("integration_connection_backend_ref_uidx").on(table.backend, table.environment, table.providerConfigKey, table.backendConnectionId),
  index("integration_connection_organization_idx").on(table.organizationId, table.environment),
  check("integration_connection_state_check", sql`${table.state} IN ('disconnected', 'authorizing', 'connected', 'degraded', 'reauthorization_required', 'revoked')`),
  check("integration_connection_backend_check", sql`${table.backend} IN ('local', 'nango')`),
  check("integration_connection_generation_check", sql`${table.generation} >= 1`),
  check("integration_connection_cleanup_check", sql`${table.cleanupPending} IS NULL OR ${table.cleanupPending} IN ('backend_delete')`),
  pgPolicy("integration_connection_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
  // The platform admin reads Connection metadata across tenants; it changes nothing.
  pgPolicy("integration_connection_platform_select", { for: "select", to: "trestle_platform", using: sql`true` }),
]).enableRLS();

/**
 * A short-lived, single-use authorization attempt. It binds the backend's
 * connect session to the organization, environment, integration, and
 * initiating principal. The session token itself is never stored: the attempt
 * ID travels to the backend as a tag, and a verified callback is resolved
 * against this row, never against the tag's organization.
 */
export const integrationAuthorizationAttempt = pgTable("integration_authorization_attempt", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  environment: text("environment").notNull(),
  backend: text("backend").notNull(),
  providerConfigKey: text("provider_config_key").notNull(),
  status: text("status").default("pending").notNull(),
  initiatedBy: text("initiated_by").notNull(),
  connectionId: uuid("connection_id"),
  failureCategory: text("failure_category"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("integration_authorization_attempt_organization_idx").on(table.organizationId, table.createdAt),
  check("integration_authorization_attempt_status_check", sql`${table.status} IN ('pending', 'completed', 'failed')`),
  check("integration_authorization_attempt_backend_check", sql`${table.backend} IN ('local', 'nango')`),
  pgPolicy("integration_authorization_attempt_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
]).enableRLS();
