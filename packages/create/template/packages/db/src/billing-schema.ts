import { bigint, boolean, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const organizationSubscription = pgTable("organization_subscription", {
  organizationId: text("organization_id").primaryKey(), provider: text("provider").notNull(), providerCustomerId: text("provider_customer_id"), providerSubscriptionId: text("provider_subscription_id"), plan: text("plan").notNull(), planVersion: integer("plan_version").default(1).notNull(), status: text("status").notNull(), currentPeriodStart: timestamp("current_period_start", { withTimezone: true }), currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }), cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("organization_subscription_provider_idx").on(table.providerSubscriptionId)]);

export const organizationEntitlement = pgTable("organization_entitlement", {
  organizationId: text("organization_id").notNull(), entitlement: text("entitlement").notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.organizationId, table.entitlement] })]);

export const organizationEntitlementOverride = pgTable("organization_entitlement_override", {
  organizationId: text("organization_id").notNull(), entitlement: text("entitlement").notNull(), enabled: boolean("enabled").notNull(), reason: text("reason").notNull(), authorId: text("author_id").notNull(), effectiveAt: timestamp("effective_at", { withTimezone: true }).defaultNow().notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  // Overrides are platform-authored and never deleted: removal is a tombstone with its own reason.
  removedAt: timestamp("removed_at", { withTimezone: true }), removedBy: text("removed_by"), removalReason: text("removal_reason"),
}, (table) => [primaryKey({ columns: [table.organizationId, table.entitlement, table.effectiveAt] })]);

export const billingProviderEvent = pgTable("billing_provider_event", {
  provider: text("provider").notNull(), providerEventId: text("provider_event_id").notNull(), providerSubscriptionId: text("provider_subscription_id"), type: text("type").notNull(), receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(), processedAt: timestamp("processed_at", { withTimezone: true }), status: text("status").default("received").notNull(), error: text("error"),
}, (table) => [primaryKey({ columns: [table.provider, table.providerEventId] })]);

/** The generation prevents a slow, stale provider lookup from overwriting a
 * newer reconciliation of the same subscription. It is provider-internal. */
export const billingSubscriptionReconciliation = pgTable("billing_subscription_reconciliation", {
  provider: text("provider").notNull(), providerSubscriptionId: text("provider_subscription_id").notNull(),
  generation: bigint("generation", { mode: "number" }).default(0).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ name: "billing_subscription_reconciliation_pk", columns: [table.provider, table.providerSubscriptionId] })]);

/** Immutable provider identity binding. Webhook metadata cannot move an
 * existing subscription to another organization's entitlement projection. */
export const billingSubscriptionOwnership = pgTable("billing_subscription_ownership", {
  provider: text("provider").notNull(), providerSubscriptionId: text("provider_subscription_id").notNull(),
  organizationId: text("organization_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ name: "billing_subscription_ownership_pk", columns: [table.provider, table.providerSubscriptionId] })]);
