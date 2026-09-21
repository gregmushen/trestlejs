import { createDatabase, organizationEntitlement, organizationSubscription, type DatabaseDriver } from "@__TRESTLE_PROJECT_NAME__/db";
import type { BillingProjectionRepository, SubscriptionSummary } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { eq, sql } from "drizzle-orm";

export class PostgresBillingProjectionRepository implements BillingProjectionRepository {
  constructor(private readonly databaseUrl: string, private readonly driver?: DatabaseDriver) {}
  async get(organizationId: string): Promise<SubscriptionSummary | null> {
    const database = createDatabase(this.databaseUrl, this.driver);
    return database.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
      const [subscription] = await transaction.select().from(organizationSubscription).where(eq(organizationSubscription.organizationId, organizationId)).limit(1);
      if (!subscription) return null;
      const entitlements = await transaction.select().from(organizationEntitlement).where(eq(organizationEntitlement.organizationId, organizationId));
      return { organizationId, provider: subscription.provider, ...(subscription.providerCustomerId ? { providerCustomerId: subscription.providerCustomerId } : {}), ...(subscription.providerSubscriptionId ? { providerSubscriptionId: subscription.providerSubscriptionId } : {}), plan: subscription.plan, status: subscription.status as SubscriptionSummary["status"], ...(subscription.currentPeriodStart ? { currentPeriodStart: subscription.currentPeriodStart } : {}), ...(subscription.currentPeriodEnd ? { currentPeriodEnd: subscription.currentPeriodEnd } : {}), cancelAtPeriodEnd: subscription.cancelAtPeriodEnd, entitlements: entitlements.map((item) => item.entitlement) };
    });
  }
  async put(value: SubscriptionSummary): Promise<void> {
    const database = createDatabase(this.databaseUrl, this.driver);
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('app.organization_id', ${value.organizationId}, true)`);
      await transaction.insert(organizationSubscription).values({ organizationId: value.organizationId, provider: value.provider, providerCustomerId: value.providerCustomerId, providerSubscriptionId: value.providerSubscriptionId, plan: value.plan, status: value.status, currentPeriodStart: value.currentPeriodStart, currentPeriodEnd: value.currentPeriodEnd, cancelAtPeriodEnd: value.cancelAtPeriodEnd, updatedAt: new Date() }).onConflictDoUpdate({ target: organizationSubscription.organizationId, set: { provider: value.provider, providerCustomerId: value.providerCustomerId, providerSubscriptionId: value.providerSubscriptionId, plan: value.plan, status: value.status, currentPeriodStart: value.currentPeriodStart, currentPeriodEnd: value.currentPeriodEnd, cancelAtPeriodEnd: value.cancelAtPeriodEnd, updatedAt: new Date() } });
      await transaction.delete(organizationEntitlement).where(eq(organizationEntitlement.organizationId, value.organizationId));
      if (value.entitlements.length > 0) await transaction.insert(organizationEntitlement).values(value.entitlements.map((entitlement) => ({ organizationId: value.organizationId, entitlement })));
    });
  }
}
