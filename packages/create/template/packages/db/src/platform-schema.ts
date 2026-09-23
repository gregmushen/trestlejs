import { sql } from "drizzle-orm";
import { index, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth-schema.js";

/**
 * Platform-role assignments: authority to operate the SaaS from the optional
 * platform admin. They are distinct from organization membership and
 * application roles and grant nothing inside a tenant. Only the
 * trestle_platform database role can read or change them; tenant runtimes
 * have no access. Revocation keeps the row as history.
 */
export const platformRoleAssignment = pgTable("platform_role_assignment", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
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
  pgPolicy("platform_role_assignment_platform", { for: "all", to: "trestle_platform", using: sql`true`, withCheck: sql`true` }),
]).enableRLS();
