import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { webhookEndpoint } from "./webhook-schema.js";

/** Endpoint signing material is encrypted before insertion. Only safe metadata is returned by management APIs. */
export const webhookSecretVersion = pgTable("webhook_secret_version", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  endpointId: uuid("endpoint_id").notNull(),
  version: integer("version").notNull(),
  ciphertext: text("ciphertext"),
  fingerprint: text("fingerprint").notNull(),
  state: text("state").notNull(),
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdBy: text("created_by").notNull(),
  auditReason: text("audit_reason"),
}, (table) => [
  uniqueIndex("webhook_secret_endpoint_version_uidx").on(table.endpointId, table.version),
  uniqueIndex("webhook_secret_current_uidx").on(table.endpointId).where(sql`${table.state} = 'current'`),
  index("webhook_secret_organization_endpoint_idx").on(table.organizationId, table.endpointId),
  foreignKey({ columns: [table.endpointId, table.organizationId], foreignColumns: [webhookEndpoint.id, webhookEndpoint.organizationId], name: "webhook_secret_endpoint_tenant_fk" }),
  check("webhook_secret_version_check", sql`${table.version} > 0`),
  check("webhook_secret_state_check", sql`${table.state} IN ('current', 'overlapping', 'revoked')`),
  check("webhook_secret_ciphertext_check", sql`(${table.state} = 'revoked' AND ${table.ciphertext} IS NULL) OR (${table.state} <> 'revoked' AND ${table.ciphertext} IS NOT NULL)`),
  pgPolicy("webhook_secret_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
]).enableRLS();
