import { boolean, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const organizationSubscription = pgTable("organization_subscription", {
  organizationId: text("organization_id").primaryKey(), provider: text("provider").notNull(), providerCustomerId: text("provider_customer_id"), providerSubscriptionId: text("provider_subscription_id"), plan: text("plan").notNull(), status: text("status").notNull(), currentPeriodStart: timestamp("current_period_start", { withTimezone: true }), currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }), cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("organization_subscription_provider_idx").on(table.providerSubscriptionId)]);

export const organizationEntitlement = pgTable("organization_entitlement", {
  organizationId: text("organization_id").notNull(), entitlement: text("entitlement").notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.organizationId, table.entitlement] })]);

export const billingProviderEvent = pgTable("billing_provider_event", {
  provider: text("provider").notNull(), providerEventId: text("provider_event_id").notNull(), type: text("type").notNull(), receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(), processedAt: timestamp("processed_at", { withTimezone: true }), status: text("status").default("received").notNull(), error: text("error"),
}, (table) => [primaryKey({ columns: [table.provider, table.providerEventId] })]);
