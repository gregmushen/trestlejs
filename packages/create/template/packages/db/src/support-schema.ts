import { sql } from "drizzle-orm";
import { check, index, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * A support session: one platform operator's time-boxed, reasoned, audited
 * access to one organization's data. A session may name a member whose
 * effective read view the operator inspects; the operator remains the actor.
 * It grants no write authority and never signs in as that member. Sessions are
 * never deleted; ending one records who ended it and why.
 */
export const supportSession = pgTable("support_session", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  operatorId: text("operator_id").notNull(),
  targetUserId: text("target_user_id"),
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

/** A single-use, short-lived browser handoff. Only the platform role can mint one. */
export const supportHandoff = pgTable("support_handoff", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => supportSession.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (table) => [
  index("support_handoff_session_idx").on(table.sessionId),
  pgPolicy("support_handoff_platform_insert", { for: "insert", to: "trestle_platform", withCheck: sql`${table.consumedAt} IS NULL` }),
]).enableRLS();

/** An opaque app-side support credential; never a Better Auth session for the viewed user. */
export const supportViewGrant = pgTable("support_view_grant", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => supportSession.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  index("support_view_grant_session_idx").on(table.sessionId),
]).enableRLS();
