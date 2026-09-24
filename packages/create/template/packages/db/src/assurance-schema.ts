import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { session } from "./auth-schema.js";

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
}, (table) => [index("authentication_assurance_user_idx").on(table.userId)]);
