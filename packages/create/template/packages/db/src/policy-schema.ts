import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Authentication policy versions (docs/ADMIN_REQUIRED_CHANGES.md §10). Safe
 * runtime policy is drafted, validated, activated with a reason and step-up,
 * and rolled back by activating a previous valid version. Setup-owned
 * settings (providers, secrets, origins, cookies, plugins) never live here.
 */
export const authPolicyVersion = pgTable("auth_policy_version", {
  version: integer("version").primaryKey(),
  state: text("state").$type<"draft" | "active" | "superseded" | "discarded">().default("draft").notNull(),
  policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
  basedOn: integer("based_on"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  activatedBy: text("activated_by"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  reason: text("reason"),
}, (table) => [
  uniqueIndex("auth_policy_version_active_uidx").on(table.state).where(sql`${table.state} = 'active'`),
  uniqueIndex("auth_policy_version_draft_uidx").on(table.state).where(sql`${table.state} = 'draft'`),
]);
