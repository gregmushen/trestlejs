import { sql } from "drizzle-orm";
import { date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
};

/** Tenant-defined custom application roles. Default roles in every plane live in source. */
export const applicationRole = pgTable("application_role", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").default("").notNull(),
  permissions: text("permissions").array().default(sql`'{}'::text[]`).notNull(),
  createdBy: text("created_by").notNull(),
  ...timestamps,
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("application_role_organization_key_uidx").on(table.organizationId, table.key)]);

/**
 * Tenant-scoped application-role assignments, deliberately separate from
 * organization membership roles (Better Auth member.role).
 */
export const applicationRoleAssignment = pgTable("application_role_assignment", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull(),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  grantedBy: text("granted_by").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: text("revoked_by"),
  revocationReason: text("revocation_reason"),
  /** Set when a directory group mapping owns this assignment; only that source may revoke it. */
  sourceProvider: text("source_provider"),
  sourceConnectionId: text("source_connection_id"),
  sourceGroupId: text("source_group_id"),
}, (table) => [
  uniqueIndex("application_role_assignment_active_uidx").on(table.organizationId, table.userId, table.role, sql`coalesce(${table.resourceType}, '')`, sql`coalesce(${table.resourceId}, '')`).where(sql`${table.revokedAt} is null`),
  index("application_role_assignment_user_idx").on(table.organizationId, table.userId),
]);

export const serviceAccount = pgTable("service_account", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  description: text("description").default("").notNull(),
  /** Application role keys. Service accounts never hold organization or platform roles. */
  applicationRoles: text("application_roles").array().default(sql`'{}'::text[]`).notNull(),
  status: text("status").$type<"active" | "suspended">().default("active").notNull(),
  createdBy: text("created_by").notNull(),
  ...timestamps,
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedBy: text("suspended_by"),
  suspensionReason: text("suspension_reason"),
  /** Deleted accounts remain as tombstones: they authenticate nothing and every key is revoked. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: text("deleted_by"),
  deletionReason: text("deletion_reason"),
}, (table) => [
  index("service_account_organization_idx").on(table.organizationId),
  uniqueIndex("service_account_active_name_uidx").on(table.organizationId, sql`lower(${table.name})`).where(sql`${table.deletedAt} is null`),
]);

export const scopeProfile = pgTable("scope_profile", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  description: text("description").default("").notNull(),
  scopes: text("scopes").array().default(sql`'{}'::text[]`).notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("scope_profile_organization_name_uidx").on(table.organizationId, table.name)]);

/** The id is the key's public identifier. Only a SHA-256 verifier is stored; never the token. */
export const apiKey = pgTable("api_key", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  serviceAccountId: text("service_account_id").notNull().references(() => serviceAccount.id, { onDelete: "restrict" }),
  environment: text("environment").notNull(),
  displayPrefix: text("display_prefix").notNull(),
  verifier: text("verifier").notNull(),
  scopes: text("scopes").array().default(sql`'{}'::text[]`).notNull(),
  scopeProfileId: text("scope_profile_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  allowedCidrs: text("allowed_cidrs").array(),
  rateLimitPerMinute: integer("rate_limit_per_minute"),
  createdBy: text("created_by").notNull(),
  ...timestamps,
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  rotatedFrom: text("rotated_from"),
  rotatedTo: text("rotated_to"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: text("revoked_by"),
  revocationReason: text("revocation_reason"),
  /** Human-readable label; the display prefix remains the stable identifier. */
  name: text("name"),
  /** A retried create with the same key returns the original key instead of minting another. */
  idempotencyKey: text("idempotency_key"),
  /** Scope widening issues a replacement key instead of mutating active authority. */
  replacedBy: text("replaced_by"),
}, (table) => [
  index("api_key_organization_idx").on(table.organizationId),
  index("api_key_service_account_idx").on(table.serviceAccountId),
  uniqueIndex("api_key_idempotency_uidx").on(table.organizationId, table.idempotencyKey),
]);

export const apiKeyUsage = pgTable("api_key_usage", {
  organizationId: text("organization_id").notNull(),
  apiKeyId: text("api_key_id").notNull(),
  day: date("day", { mode: "string" }).notNull(),
  requests: integer("requests").default(0).notNull(),
  denied: integer("denied").default(0).notNull(),
}, (table) => [
  primaryKey({ columns: [table.apiKeyId, table.day] }),
  index("api_key_usage_organization_idx").on(table.organizationId, table.day),
]);

export const platformRoleAssignment = pgTable("platform_role_assignment", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  role: text("role").notNull(),
  grantedBy: text("granted_by").notNull(),
  reason: text("reason").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: text("revoked_by"),
  revocationReason: text("revocation_reason"),
}, (table) => [
  uniqueIndex("platform_role_assignment_active_uidx").on(table.userId, table.role).where(sql`${table.revokedAt} is null`),
  index("platform_role_assignment_user_idx").on(table.userId),
]);

/**
 * Support sessions: an operator's audited, time-boxed tenant context. The
 * profile and its permission snapshot are fixed when the session starts.
 */
export const supportSession = pgTable("support_session", {
  id: text("id").primaryKey(),
  operatorId: text("operator_id").notNull(),
  organizationId: text("organization_id").notNull(),
  reason: text("reason").notNull(),
  ticket: text("ticket"),
  profile: text("profile").notNull(),
  permissions: jsonb("permissions").$type<{ organization: string[]; application: string[]; denied: string[] }>().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: text("end_reason").$type<"exited" | "expired" | "revoked" | "replaced">(),
  endedBy: text("ended_by"),
  revocationReason: text("revocation_reason"),
}, (table) => [
  index("support_session_operator_idx").on(table.operatorId, table.startedAt),
  index("support_session_organization_idx").on(table.organizationId, table.startedAt),
  uniqueIndex("support_session_active_uidx").on(table.operatorId).where(sql`${table.endedAt} is null`),
]);

/**
 * Runtime, grant-only permissions (docs/ADMIN_REQUIRED_CHANGES.md §5.3).
 * Organization or application plane only; platform authority stays in code.
 */
export const accessPermission = pgTable("access_permission", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  plane: text("plane").$type<"organization" | "application">().notNull(),
  principals: text("principals").array().default(sql`'{user}'::text[]`).notNull(),
  entitlement: text("entitlement"),
  state: text("state").$type<"active" | "deprecated">().default("active").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
});

/** Global catalog roles, available to every organization next to the built-in roles (§5.1, §5.2). */
export const accessRole = pgTable("access_role", {
  plane: text("plane").$type<"organization" | "application">().notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").default("").notNull(),
  permissions: text("permissions").array().default(sql`'{}'::text[]`).notNull(),
  /** The role this one was cloned from, for provenance. */
  basedOn: text("based_on"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.plane, table.key] })]);
