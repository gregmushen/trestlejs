import { sql } from "drizzle-orm";
import { bigint, boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** Platform-wide plan catalog. Rows are immutable once they leave draft. */
export const planVersion = pgTable("plan_version", {
  plan: text("plan").notNull(),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  state: text("state").$type<"draft" | "active" | "grandfathered" | "retired">().default("draft").notNull(),
  entitlements: jsonb("entitlements").$type<Record<string, Record<string, boolean | number | string | null>>>().default({}).notNull(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  grandfatheredAt: timestamp("grandfathered_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.plan, table.version] })]);

export const subscriptionOverride = pgTable("subscription_override", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  code: text("code").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  values: jsonb("values").$type<Record<string, boolean | number | string | null>>().default({}).notNull(),
  reason: text("reason").notNull(),
  author: text("author").notNull(),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  removedBy: text("removed_by"),
  removalReason: text("removal_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("subscription_override_organization_idx").on(table.organizationId)]);

export const subscriptionChange = pgTable("subscription_change", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  toPlanVersion: text("to_plan_version").notNull(),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  reason: text("reason").notNull(),
  author: text("author").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("subscription_change_organization_idx").on(table.organizationId)]);

export const usageAggregate = pgTable("usage_aggregate", {
  organizationId: text("organization_id").notNull(),
  featureCode: text("feature_code").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  quantity: bigint("quantity", { mode: "number" }).default(0).notNull(),
  /** How much of `quantity` the metering provider has accepted; the runner reports the difference. */
  reportedQuantity: bigint("reported_quantity", { mode: "number" }).default(0).notNull(),
  /** Provider figures from reconciliation. Informational: request paths read `quantity`. */
  provider: text("provider"),
  providerQuantity: bigint("provider_quantity", { mode: "number" }),
  providerBalance: doublePrecision("provider_balance"),
  providerHasAccess: boolean("provider_has_access"),
  providerObservedAt: timestamp("provider_observed_at", { withTimezone: true }),
}, (table) => [primaryKey({ columns: [table.organizationId, table.featureCode, table.periodStart] })]);

export const providerReconciliation = pgTable("provider_reconciliation", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  provider: text("provider").notNull(),
  outcome: text("outcome").notNull(),
  differences: jsonb("differences").$type<Array<{ field: string; local: string | null; provider: string | null }>>().default([]).notNull(),
  repaired: boolean("repaired").default(false).notNull(),
  actor: text("actor").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("provider_reconciliation_organization_idx").on(table.organizationId, table.createdAt)]);

/**
 * Explicit payment-provider linkage (docs/ADMIN_REQUIRED_CHANGES.md §4.2).
 * Plan family -> Product, plan version + offer -> Price, per environment.
 * Mappings are never inferred from display names.
 */
export const billingProviderMapping = pgTable("billing_provider_mapping", {
  id: uuid("id").defaultRandom().primaryKey(),
  environment: text("environment").notNull(),
  provider: text("provider").notNull(),
  kind: text("kind").$type<"product" | "price">().notNull(),
  plan: text("plan").notNull(),
  planVersion: integer("plan_version"),
  /** Billing offer within a version, e.g. monthly or annual. Prices only. */
  offer: text("offer"),
  externalId: text("external_id").notNull(),
  /** What the provider reported when last verified; never credentials. */
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  verification: jsonb("verification").$type<Record<string, unknown>>(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("billing_provider_mapping_target_uidx").on(table.environment, table.provider, table.kind, table.plan, sql`coalesce(${table.planVersion}, 0)`, sql`coalesce(${table.offer}, '')`),
  uniqueIndex("billing_provider_mapping_external_uidx").on(table.environment, table.provider, table.kind, table.externalId),
]);

/** One subscription line and the provider item and price it corresponds to. */
export const subscriptionLine = pgTable("subscription_line", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  planVersion: text("plan_version").notNull(),
  offer: text("offer"),
  quantity: integer("quantity").default(1).notNull(),
  providerItemId: text("provider_item_id"),
  providerPriceId: text("provider_price_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("subscription_line_organization_idx").on(table.organizationId)]);
