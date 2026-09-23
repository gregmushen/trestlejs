import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth-schema.js";

/*
 * Enterprise identity. The first block is owned by the Better Auth SSO and
 * SCIM plugins (field names match their schema exactly; generated from
 * getAuthTables for better-auth 1.7.5). SCIM uses the Trestle organization ID
 * as its provisioning domain. The second block is Trestle's own: connection
 * bindings, group-to-role mappings, and idempotent directory events.
 */

export const ssoProvider = pgTable("sso_provider", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config"),
  samlConfig: text("saml_config"),
  userId: text("user_id").references(() => user.id),
  providerId: text("provider_id").notNull().unique(),
  organizationId: text("organization_id"),
  domain: text("domain").notNull(),
  /** Written by Better Auth when domain verification is enabled (every environment but local). */
  domainVerified: boolean("domain_verified").default(false),
});

export const scimManagedConnection = pgTable("scim_managed_connection", {
  id: text("id").primaryKey(),
  creationRequestId: text("creation_request_id").notNull().unique(),
  connectionId: text("connection_id").notNull().unique(),
  provisioningDomainId: text("provisioning_domain_id").notNull(),
  status: text("status").notNull(),
  revision: integer("revision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  createdBy: text("created_by").notNull(),
  decommissionStartedAt: timestamp("decommission_started_at", { withTimezone: true }),
  decommissionStartedBy: text("decommission_started_by"),
  decommissionedAt: timestamp("decommissioned_at", { withTimezone: true }),
  decommissionedBy: text("decommissioned_by"),
}, (table) => [index("scim_managed_connection_provisioning_domain_id_idx").on(table.provisioningDomainId)]);

export const scimManagedCredential = pgTable("scim_managed_credential", {
  id: text("id").primaryKey(),
  connectionRecordId: text("connection_record_id").notNull().references(() => scimManagedConnection.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull().unique(),
  tokenDigest: text("token_digest").notNull(),
  hashVersion: text("hash_version").notNull(),
  activeSlotKey: text("active_slot_key").notNull().unique(),
  status: text("status").notNull(),
  serializedScopes: text("serialized_scopes").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  createdBy: text("created_by").notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: text("revoked_by"),
  decommissionedAt: timestamp("decommissioned_at", { withTimezone: true }),
}, (table) => [index("scim_managed_credential_connection_record_id_idx").on(table.connectionRecordId)]);

export const scimManagedConnectionEvent = pgTable("scim_managed_connection_event", {
  id: text("id").primaryKey(),
  connectionRecordId: text("connection_record_id").notNull().references(() => scimManagedConnection.id, { onDelete: "cascade" }),
  eventKey: text("event_key").notNull().unique(),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  actorId: text("actor_id").notNull(),
  credentialId: text("credential_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [index("scim_managed_connection_event_connection_record_id_idx").on(table.connectionRecordId)]);

export const scimConnectionBinding = pgTable("scim_connection_binding", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  connectionKey: text("connection_key").notNull().unique(),
  provisioningDomainId: text("provisioning_domain_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  decommissionedAt: timestamp("decommissioned_at", { withTimezone: true }),
  decommissionStatus: text("decommission_status").notNull(),
  decommissionCursorUserId: text("decommission_cursor_user_id"),
  decommissionReconciledUserCount: integer("decommission_reconciled_user_count").notNull(),
  decommissionBatchCount: integer("decommission_batch_count").notNull(),
  decommissionRevision: integer("decommission_revision").notNull(),
  decommissionCompletedAt: timestamp("decommission_completed_at", { withTimezone: true }),
  decommissionLeaseId: text("decommission_lease_id"),
  decommissionLeaseExpiresAt: timestamp("decommission_lease_expires_at", { withTimezone: true }),
}, (table) => [index("scim_connection_binding_connection_id_idx").on(table.connectionId)]);

export const scimIdentityTombstone = pgTable("scim_identity_tombstone", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  provisioningDomainId: text("provisioning_domain_id").notNull(),
  externalId: text("external_id").notNull(),
  externalIdKey: text("external_id_key").notNull().unique(),
  userId: text("user_id").notNull().references(() => user.id),
  profile: text("profile").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull(),
}, (table) => [index("scim_identity_tombstone_connection_id_idx").on(table.connectionId), index("scim_identity_tombstone_provisioning_domain_id_idx").on(table.provisioningDomainId), index("scim_identity_tombstone_user_id_idx").on(table.userId)]);

export const scimSubject = pgTable("scim_subject", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique().references(() => user.id),
  profileSourceId: text("profile_source_id"),
  revision: integer("revision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [index("scim_subject_profile_source_id_idx").on(table.profileSourceId)]);

export const scimUser = pgTable("scim_user", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  provisioningDomainId: text("provisioning_domain_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id),
  connectionUserKey: text("connection_user_key").notNull().unique(),
  userName: text("user_name").notNull(),
  userNameKey: text("user_name_key").notNull().unique(),
  primaryEmail: text("primary_email").notNull(),
  workEmailValueIndex: text("work_email_value_index").notNull(),
  emailValueIndex: text("email_value_index").notNull(),
  displayName: text("display_name").notNull(),
  formattedName: text("formatted_name").notNull(),
  givenName: text("given_name"),
  familyName: text("family_name"),
  serializedEmails: text("serialized_emails").notNull(),
  serializedAttributes: text("serialized_attributes"),
  externalId: text("external_id"),
  externalIdKey: text("external_id_key").unique(),
  active: boolean("active").notNull(),
  orderKey: text("order_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [index("scim_user_connection_id_idx").on(table.connectionId), index("scim_user_provisioning_domain_id_idx").on(table.provisioningDomainId), index("scim_user_user_id_idx").on(table.userId)]);

export const scimProjectionGrant = pgTable("scim_projection_grant", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  provisioningDomainId: text("provisioning_domain_id").notNull(),
  scimUserId: text("scim_user_id").notNull().references(() => scimUser.id),
  userId: text("user_id").notNull().references(() => user.id),
  sourceKind: text("source_kind").notNull(),
  sourceId: text("source_id").notNull(),
  sourceValue: text("source_value"),
  role: text("role").notNull(),
  grantKey: text("grant_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [index("scim_projection_grant_connection_id_idx").on(table.connectionId), index("scim_projection_grant_provisioning_domain_id_idx").on(table.provisioningDomainId), index("scim_projection_grant_scim_user_id_idx").on(table.scimUserId), index("scim_projection_grant_user_id_idx").on(table.userId)]);

export const scimGroup = pgTable("scim_group", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  provisioningDomainId: text("provisioning_domain_id").notNull(),
  revision: integer("revision").notNull(),
  displayName: text("display_name").notNull(),
  displayNameKey: text("display_name_key").notNull().unique(),
  externalId: text("external_id"),
  externalIdKey: text("external_id_key").unique(),
  orderKey: text("order_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [index("scim_group_connection_id_idx").on(table.connectionId), index("scim_group_provisioning_domain_id_idx").on(table.provisioningDomainId)]);

export const scimGroupMember = pgTable("scim_group_member", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  groupId: text("group_id").notNull().references(() => scimGroup.id),
  scimUserId: text("scim_user_id").notNull().references(() => scimUser.id),
  membershipKey: text("membership_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [index("scim_group_member_connection_id_idx").on(table.connectionId), index("scim_group_member_group_id_idx").on(table.groupId), index("scim_group_member_scim_user_id_idx").on(table.scimUserId)]);

/** A provider connection bound to one Trestle organization, for status and routing. Never holds a credential. */
export const identityConnection = pgTable("identity_connection", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  provider: text("provider").notNull(),
  kind: text("kind").notNull(),
  /** Better Auth providerId or SCIM connectionId; WorkOS organization or directory ID. */
  externalId: text("external_id").notNull(),
  domain: text("domain"),
  state: text("state").default("active").notNull(),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  /** A safe failure category, never a provider response body. */
  lastError: text("last_error"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  // A WorkOS organization binds one row per verified domain.
  uniqueIndex("identity_connection_external_uidx").on(table.provider, table.kind, table.externalId, sql`coalesce(${table.domain}, '')`),
  index("identity_connection_domain_idx").on(table.provider, table.kind, table.domain),
  index("identity_connection_organization_idx").on(table.organizationId),
  check("identity_connection_kind_check", sql`${table.kind} in ('sso', 'directory')`),
]);

/** Maps one external group to one organization- or application-plane role. Platform roles are refused by a check constraint. */
export const externalRoleMapping = pgTable("external_role_mapping", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  provider: text("provider").notNull(),
  connectionId: text("connection_id").notNull(),
  externalGroupId: text("external_group_id").notNull(),
  targetPlane: text("target_plane").notNull(),
  targetRole: text("target_role").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("external_role_mapping_uidx").on(table.organizationId, table.provider, table.connectionId, table.externalGroupId, table.targetPlane, table.targetRole),
  index("external_role_mapping_connection_idx").on(table.provider, table.connectionId),
  check("external_role_mapping_plane_check", sql`${table.targetPlane} in ('organization', 'application')`),
  check("external_role_mapping_owner_check", sql`not (${table.targetPlane} = 'organization' and ${table.targetRole} = 'owner')`),
]);

/** Processed inbound directory events; the ID makes webhook redelivery a no-op. */
export const directoryEvent = pgTable("directory_event", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  provider: text("provider").notNull(),
  type: text("type").notNull(),
  outcome: text("outcome").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("directory_event_organization_idx").on(table.organizationId, table.receivedAt)]);

