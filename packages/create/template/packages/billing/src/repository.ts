import { createTenantDatabase, organizationEntitlement, organizationEntitlementOverride, organizationSubscription, type DatabaseDriver } from "@__TRESTLE_PROJECT_NAME__/db";
import type { BillingProjectionRepository, SubscriptionSummary } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { Entitlements } from "./entitlements.js";

export class PostgresBillingProjectionRepository implements BillingProjectionRepository {
  constructor(private readonly databaseUrl: string, private readonly driver?: DatabaseDriver) {}
  async get(organizationId: string): Promise<SubscriptionSummary | null> {
    const database = createTenantDatabase(this.databaseUrl, this.driver, organizationId);
    return database.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
      const [subscription] = await transaction.select().from(organizationSubscription).where(eq(organizationSubscription.organizationId, organizationId)).limit(1);
      if (!subscription) return null;
      const entitlements = await transaction.select().from(organizationEntitlement).where(eq(organizationEntitlement.organizationId, organizationId));
      const now = new Date();
      const overrides = await transaction.select().from(organizationEntitlementOverride).where(and(eq(organizationEntitlementOverride.organizationId, organizationId), lte(organizationEntitlementOverride.effectiveAt, now), or(isNull(organizationEntitlementOverride.expiresAt), gt(organizationEntitlementOverride.expiresAt, now))));
      const resolved = new Entitlements(new Set(entitlements.map((item) => item.entitlement)), { plan: subscription.plan, planVersion: subscription.planVersion, now, overrides: overrides.map((item) => ({ code: item.entitlement, enabled: item.enabled, reason: item.reason, authorId: item.authorId, effectiveAt: item.effectiveAt, ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}) })) });
      return { organizationId, provider: subscription.provider, ...(subscription.providerCustomerId ? { providerCustomerId: subscription.providerCustomerId } : {}), ...(subscription.providerSubscriptionId ? { providerSubscriptionId: subscription.providerSubscriptionId } : {}), plan: subscription.plan, planVersion: subscription.planVersion, status: subscription.status as SubscriptionSummary["status"], ...(subscription.currentPeriodStart ? { currentPeriodStart: subscription.currentPeriodStart } : {}), ...(subscription.currentPeriodEnd ? { currentPeriodEnd: subscription.currentPeriodEnd } : {}), cancelAtPeriodEnd: subscription.cancelAtPeriodEnd, entitlements: resolved.list(), effectiveEntitlements: resolved.explain() };
    });
  }
  async put(value: SubscriptionSummary): Promise<void> {
    const database = createTenantDatabase(this.databaseUrl, this.driver, value.organizationId);
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('app.organization_id', ${value.organizationId}, true)`);
      await transaction.insert(organizationSubscription).values({ organizationId: value.organizationId, provider: value.provider, providerCustomerId: value.providerCustomerId, providerSubscriptionId: value.providerSubscriptionId, plan: value.plan, planVersion: value.planVersion, status: value.status, currentPeriodStart: value.currentPeriodStart, currentPeriodEnd: value.currentPeriodEnd, cancelAtPeriodEnd: value.cancelAtPeriodEnd, updatedAt: new Date() }).onConflictDoUpdate({ target: organizationSubscription.organizationId, set: { provider: value.provider, providerCustomerId: value.providerCustomerId, providerSubscriptionId: value.providerSubscriptionId, plan: value.plan, planVersion: value.planVersion, status: value.status, currentPeriodStart: value.currentPeriodStart, currentPeriodEnd: value.currentPeriodEnd, cancelAtPeriodEnd: value.cancelAtPeriodEnd, updatedAt: new Date() } });
      await transaction.delete(organizationEntitlement).where(eq(organizationEntitlement.organizationId, value.organizationId));
      if (value.entitlements.length > 0) await transaction.insert(organizationEntitlement).values(value.entitlements.map((entitlement) => ({ organizationId: value.organizationId, entitlement })));
    });
  }
}
