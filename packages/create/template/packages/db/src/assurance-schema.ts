import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { session } from "./auth-schema.js";

/** Allowed assurance values; the CHECK constraints below are built from these lists. */
export const sessionAssuranceLevels = ["password", "mfa", "phishing_resistant"] as const;
export const sessionAssuranceMethods = ["password", "totp", "otp", "backup_code", "passkey", "sso"] as const;
export type SessionAssuranceLevel = (typeof sessionAssuranceLevels)[number];
export type SessionAssuranceMethod = (typeof sessionAssuranceMethods)[number];

// Literal constants only (never user input), rendered exactly as the migration's IN list.
const inList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

/**
 * How each session was authenticated and when. Written by the auth hook when
 * Better Auth creates a session; read by the admin Worker to enforce step-up.
 * It holds no credential material.
 */
export const authenticationAssurance = pgTable("authentication_assurance", {
  sessionId: text("session_id").primaryKey().references(() => session.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  level: text("level").notNull(),
  method: text("method").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
}, (table) => [
  index("authentication_assurance_user_idx").on(table.userId),
  check("authentication_assurance_level_check", sql`${table.level} IN (${inList(sessionAssuranceLevels)})`),
  check("authentication_assurance_method_check", sql`${table.method} IN (${inList(sessionAssuranceMethods)})`),
]);
