import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * An organization's regional defaults. Every value is nullable: null inherits
 * the application default. Values are canonical identifiers (BCP 47, IANA,
 * ISO 4217); changing them never rewrites historical data.
 */
export const organizationRegionalSettings = pgTable("organization_regional_settings", {
  organizationId: text("organization_id").primaryKey(),
  language: text("language"),
  locale: text("locale"),
  timeZone: text("time_zone"),
  currency: text("currency"),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  pgPolicy("organization_regional_settings_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
  pgPolicy("organization_regional_settings_platform_select", { for: "select", to: "trestle_platform", using: sql`true` }),
]).enableRLS();
