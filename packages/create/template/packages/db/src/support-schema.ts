import { sql } from "drizzle-orm";
import { check, index, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * A support session: one platform operator's time-boxed, reasoned, audited
 * access to one organization's data in the platform admin. It grants no
 * tenant-application authority and never impersonates a user. Sessions are
 * never deleted; ending one records who ended it and why.
 */
export const supportSession = pgTable("support_session", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  operatorId: text("operator_id").notNull(),
  reason: text("reason").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endedBy: text("ended_by"),
  correlationId: text("correlation_id").notNull(),
}, (table) => [
  index("support_session_organization_idx").on(table.organizationId, table.startedAt),
  // An operator holds at most one open session at a time.
  uniqueIndex("support_session_open_operator_uidx").on(table.operatorId).where(sql`${table.endedAt} is null`),
  check("support_session_window_check", sql`${table.expiresAt} > ${table.startedAt} AND ${table.expiresAt} <= ${table.startedAt} + interval '4 hours'`),
  check("support_session_end_check", sql`(${table.endedAt} IS NULL AND ${table.endedBy} IS NULL) OR (${table.endedAt} IS NOT NULL AND ${table.endedBy} IS NOT NULL)`),
  pgPolicy("support_session_platform_select", { for: "select", to: "trestle_platform", using: sql`true` }),
  pgPolicy("support_session_platform_insert", { for: "insert", to: "trestle_platform", withCheck: sql`${table.endedAt} IS NULL` }),
  pgPolicy("support_session_platform_end", { for: "update", to: "trestle_platform", using: sql`${table.endedAt} IS NULL`, withCheck: sql`${table.endedAt} IS NOT NULL` }),
]).enableRLS();
