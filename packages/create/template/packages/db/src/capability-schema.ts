import { boolean, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Sanitized capability-status projection reported by the running customer
 * Worker. It records presence and health only, never configuration values.
 */
export const capabilityStatus = pgTable("capability_status", {
  environment: text("environment").notNull(),
  capabilityId: text("capability_id").notNull(),
  label: text("label").notNull(),
  state: text("state").$type<"disabled" | "declared" | "configured" | "deployed" | "verified">().notNull(),
  healthy: boolean("healthy").notNull(),
  /** Provider mode such as "local capture" or "Stripe test mode"; never a credential. */
  mode: text("mode"),
  message: text("message"),
  repair: text("repair"),
  reportedAt: timestamp("reported_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.environment, table.capabilityId] })]);
