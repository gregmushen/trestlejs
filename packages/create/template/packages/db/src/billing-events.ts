import { and, eq, ne, sql } from "drizzle-orm";

import { billingProviderEvent, organizationEntitlement, organizationSubscription } from "./billing-schema.js";
import { createDatabase, createTenantDatabase, type DatabaseDriver } from "./index.js";

export type BillingWebhookProjection = {
  organizationId: string;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  plan: string;
  planVersion: number;
  status: "active" | "trialing" | "past_due" | "cancelled" | "incomplete";
  cancelAtPeriodEnd?: boolean;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  entitlements: readonly string[];
};

/** A durable receipt is created before processing so a crash can be retried.
 * The row lock serializes duplicate deliveries. Projection and final receipt
 * status commit together, so neither can be acknowledged alone. */
export async function applyBillingProviderEvent(input: {
  databaseUrl: string;
  driver?: DatabaseDriver;
  provider: string;
  providerEventId: string;
  type: string;
  projection?: BillingWebhookProjection;
}): Promise<{ duplicate: boolean }> {
  if (!input.provider || !input.providerEventId || !input.type) throw new Error("Invalid billing provider event identity");
  const database = createDatabase(input.databaseUrl, input.driver);
  const key = and(eq(billingProviderEvent.provider, input.provider), eq(billingProviderEvent.providerEventId, input.providerEventId));
  await database.insert(billingProviderEvent).values({ provider: input.provider, providerEventId: input.providerEventId, type: input.type }).onConflictDoNothing();
  try {
    const scoped = input.projection ? createTenantDatabase(input.databaseUrl, input.driver, input.projection.organizationId) : database;
    return await scoped.transaction(async (transaction) => {
      if (input.projection) await transaction.execute(sql`select set_config('app.organization_id', ${input.projection.organizationId}, true)`);
      const [receipt] = await transaction.select({ status: billingProviderEvent.status }).from(billingProviderEvent).where(key).for("update").limit(1);
      if (!receipt) throw new Error("Billing provider event receipt disappeared");
      if (receipt.status === "processed") return { duplicate: true };
      if (input.projection) {
        const value = input.projection;
        const updatedAt = new Date();
        await transaction.insert(organizationSubscription).values({
          organizationId: value.organizationId, provider: input.provider, providerCustomerId: value.providerCustomerId,
          providerSubscriptionId: value.providerSubscriptionId, plan: value.plan, planVersion: value.planVersion,
          status: value.status, cancelAtPeriodEnd: value.cancelAtPeriodEnd ?? value.status === "cancelled",
          currentPeriodStart: value.currentPeriodStart, currentPeriodEnd: value.currentPeriodEnd, updatedAt,
        }).onConflictDoUpdate({ target: organizationSubscription.organizationId, set: {
          provider: input.provider, providerCustomerId: value.providerCustomerId, providerSubscriptionId: value.providerSubscriptionId,
          plan: value.plan, planVersion: value.planVersion, status: value.status,
          cancelAtPeriodEnd: value.cancelAtPeriodEnd ?? value.status === "cancelled",
          currentPeriodStart: value.currentPeriodStart, currentPeriodEnd: value.currentPeriodEnd, updatedAt,
        } });
        await transaction.delete(organizationEntitlement).where(eq(organizationEntitlement.organizationId, value.organizationId));
        if (value.entitlements.length > 0) await transaction.insert(organizationEntitlement).values(value.entitlements.map((entitlement) => ({ organizationId: value.organizationId, entitlement })));
      }
      await transaction.update(billingProviderEvent).set({ status: "processed", processedAt: new Date(), error: null }).where(key);
      return { duplicate: false };
    });
  } catch (error) {
    await database.update(billingProviderEvent).set({ status: "failed", error: "projection_failed" }).where(and(key, ne(billingProviderEvent.status, "processed"))).catch(() => undefined);
    throw error;
  }
}
