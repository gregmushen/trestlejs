import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./auth-schema.js";

/**
 * Organization regional defaults. Every column is nullable: null means
 * "inherit the application default". Values are canonical identifiers
 * (BCP 47, IANA, ISO 4217); changing them never rewrites historical data.
 */
export const organizationRegionalSettings = pgTable("organization_regional_settings", {
  organizationId: text("organization_id").primaryKey(),
  language: text("language"),
  locale: text("locale"),
  timeZone: text("time_zone"),
  currency: text("currency"),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A user's own language and region preferences. They follow the account
 * across organizations; forced RLS keys on the request's user, not a tenant.
 */
export const userRegionalPreference = pgTable("user_regional_preference", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  language: text("language"),
  locale: text("locale"),
  timeZone: text("time_zone"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
