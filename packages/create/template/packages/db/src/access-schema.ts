import { sql } from "drizzle-orm";
import { index, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth-schema.js";

/**
 * Application-role assignments: product authority, stored separately from
 * Better Auth organization membership (`member.role`). Revocation keeps the
 * row as history; at most one active assignment exists per role.
 */
export const applicationRoleAssignment = pgTable("application_role_assignment", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  grantedBy: text("granted_by").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: text("revoked_by"),
}, (table) => [
  uniqueIndex("application_role_assignment_active_uidx").on(table.organizationId, table.userId, table.role).where(sql`${table.revokedAt} is null`),
  index("application_role_assignment_user_idx").on(table.organizationId, table.userId),
  pgPolicy("application_role_assignment_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
]).enableRLS();
