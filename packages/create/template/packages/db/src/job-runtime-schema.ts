import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgPolicy, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The job runtime each environment runs on. One row per environment: the
 * customer Worker records what it was deployed with (`declared_*`), and the
 * platform admin records operator changes (`override_*`). The
 * effective setting is the override when set, else the declared value. No
 * column holds a credential; secrets stay in the encrypted credential store.
 */
export const jobRuntimeConfig = pgTable("job_runtime_config", {
  environment: text("environment").primaryKey(),
  declaredRuntime: text("declared_runtime").notNull(),
  declaredHosting: text("declared_hosting").notNull(),
  declaredEndpoint: text("declared_endpoint"),
  declaredProject: text("declared_project"),
  declaredAt: timestamp("declared_at", { withTimezone: true }).defaultNow().notNull(),
  /** Runtimes whose adapter is installed in the deployed Worker. */
  declaredAvailable: text("declared_available").array(),
  /** Presence only ({ NAME: true | false }) of the credentials each runtime needs; never a value. */
  declaredCredentials: jsonb("declared_credentials"),
  overrideRuntime: text("override_runtime"),
  overrideHosting: text("override_hosting"),
  overrideEndpoint: text("override_endpoint"),
  overrideProject: text("override_project"),
  overrideSettings: jsonb("override_settings"),
  overrideVersion: integer("override_version").default(0).notNull(),
  overriddenBy: text("overridden_by"),
  overriddenAt: timestamp("overridden_at", { withTimezone: true }),
  /** The effective runtime before the last admin engine switch, and when it switched, for the Jobs view's migration status. */
  switchedFrom: text("switched_from"),
  switchedAt: timestamp("switched_at", { withTimezone: true }),
}, (table) => [
  check("job_runtime_config_declared_runtime_check", sql`${table.declaredRuntime} IN ('cloudflare', 'trigger', 'inngest')`),
  check("job_runtime_config_declared_hosting_check", sql`${table.declaredHosting} IN ('cloud', 'self-hosted', 'cloudflare')`),
  check("job_runtime_config_override_runtime_check", sql`${table.overrideRuntime} IS NULL OR ${table.overrideRuntime} IN ('cloudflare', 'trigger', 'inngest')`),
  check("job_runtime_config_override_hosting_check", sql`${table.overrideHosting} IS NULL OR ${table.overrideHosting} IN ('cloud', 'self-hosted', 'cloudflare')`),
  // The customer Worker declares its deploy-time runtime; column grants limit it to the declared_* columns.
  pgPolicy("job_runtime_config_app_declare", { for: "all", to: "trestle_app", using: sql`true`, withCheck: sql`true` }),
  pgPolicy("job_runtime_config_platform_select", { for: "select", to: "trestle_platform", using: sql`true` }),
  // Platform admin records overrides; column grants limit it to the override_* and switch columns.
  pgPolicy("job_runtime_config_platform_override", { for: "update", to: "trestle_platform", using: sql`true`, withCheck: sql`true` }),
]).enableRLS();
