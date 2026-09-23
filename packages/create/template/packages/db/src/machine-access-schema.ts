import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgPolicy, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Machine access: a service account is a non-human principal owned by one
 * organization, holding application roles only. Its API keys carry a subset of
 * that authority as scopes. Keys store a SHA-256 verifier, never the token.
 */
export const serviceAccount = pgTable("service_account", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  applicationRoles: text("application_roles").array().notNull(),
  status: text("status").default("active").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("service_account_id_organization_uidx").on(table.id, table.organizationId),
  uniqueIndex("service_account_name_uidx").on(table.organizationId, sql`lower(${table.name})`),
  check("service_account_status_check", sql`${table.status} IN ('active', 'suspended')`),
  pgPolicy("service_account_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
  pgPolicy("service_account_platform_select", { for: "select", to: "trestle_platform", using: sql`true` }),
]).enableRLS();

export const apiKey = pgTable("api_key", {
  /** The token's 16-character public ID. */
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  serviceAccountId: text("service_account_id").notNull(),
  name: text("name").notNull(),
  environment: text("environment").notNull(),
  displayPrefix: text("display_prefix").notNull(),
  verifier: text("verifier").notNull(),
  scopes: text("scopes").array().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  rotatedFrom: text("rotated_from"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: text("revoked_by"),
  revocationReason: text("revocation_reason"),
}, (table) => [
  index("api_key_service_account_idx").on(table.organizationId, table.serviceAccountId),
  foreignKey({ columns: [table.serviceAccountId, table.organizationId], foreignColumns: [serviceAccount.id, serviceAccount.organizationId], name: "api_key_service_account_tenant_fk" }),
  check("api_key_id_check", sql`${table.id} ~ '^[A-Za-z0-9]{16}$'`),
  check("api_key_environment_check", sql`${table.environment} IN ('local', 'preview', 'staging', 'production')`),
  check("api_key_verifier_check", sql`${table.verifier} ~ '^[a-f0-9]{64}$'`),
  check("api_key_revocation_check", sql`(${table.revokedAt} IS NULL AND ${table.revokedBy} IS NULL AND ${table.revocationReason} IS NULL) OR (${table.revokedAt} IS NOT NULL AND ${table.revokedBy} IS NOT NULL AND ${table.revocationReason} IS NOT NULL)`),
  pgPolicy("api_key_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
  // The platform admin reads key metadata (never verifiers) and may only revoke an active key.
  pgPolicy("api_key_platform_select", { for: "select", to: "trestle_platform", using: sql`true` }),
  pgPolicy("api_key_platform_revoke", { for: "update", to: "trestle_platform", using: sql`${table.revokedAt} IS NULL`, withCheck: sql`${table.revokedAt} IS NOT NULL` }),
]).enableRLS();
