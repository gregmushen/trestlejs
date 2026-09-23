import { boolean, index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const organizationSubscription = pgTable("organization_subscription", {
  organizationId: text("organization_id").primaryKey(), provider: text("provider").notNull(), providerCustomerId: text("provider_customer_id"), providerSubscriptionId: text("provider_subscription_id"), plan: text("plan").notNull(), planVersion: text("plan_version"), status: text("status").notNull(), startedAt: timestamp("started_at", { withTimezone: true }), currentPeriodStart: timestamp("current_period_start", { withTimezone: true }), currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }), cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("organization_subscription_provider_idx").on(table.providerSubscriptionId)]);

/** Effective-entitlement projection with safe provenance. */
export const organizationEntitlement = pgTable("organization_entitlement", {
  organizationId: text("organization_id").notNull(), entitlement: text("entitlement").notNull(), enabled: boolean("enabled").default(true).notNull(), values: jsonb("values").$type<Record<string, boolean | number | string | null>>().default({}).notNull(), source: text("source").$type<"plan" | "subscription_override">().default("plan").notNull(), inheritedFrom: text("inherited_from"), overrideId: text("override_id"), effectiveAt: timestamp("effective_at", { withTimezone: true }).defaultNow().notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.organizationId, table.entitlement] })]);


export const billingProviderEvent = pgTable("billing_provider_event", {
  provider: text("provider").notNull(), providerEventId: text("provider_event_id").notNull(), type: text("type").notNull(), receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(), processedAt: timestamp("processed_at", { withTimezone: true }), status: text("status").default("received").notNull(), error: text("error"),
}, (table) => [primaryKey({ columns: [table.provider, table.providerEventId] })]);
