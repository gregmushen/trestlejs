import { and, eq, notInArray, sql } from "drizzle-orm";

import { billingProviderEvent, billingSubscriptionOwnership, billingSubscriptionReconciliation, organizationEntitlement, organizationSubscription } from "./billing-schema.js";
import { createDatabase, createTenantDatabase, type DatabaseDriver } from "./index.js";
import { outboxApplicationConnectionString } from "./outbox.js";

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

/** Claim a signed subscription notification before asking the provider for
 * current state. Incrementing under the receipt lock makes overlapping
 * lookups distinguishable without holding a DB transaction across HTTP. */
export async function beginBillingSubscriptionReconciliation(input: {
  databaseUrl: string;
  driver?: DatabaseDriver;
  provider: string;
  providerEventId: string;
  providerSubscriptionId: string;
  type: string;
}): Promise<{ duplicate: true } | { duplicate: false; generation: number }> {
  if (!input.provider || !input.providerEventId || !input.providerSubscriptionId || !input.type) throw new Error("Invalid billing reconciliation identity");
  const database = createDatabase(outboxApplicationConnectionString(input.databaseUrl), input.driver);
  const receiptKey = and(eq(billingProviderEvent.provider, input.provider), eq(billingProviderEvent.providerEventId, input.providerEventId));
  return await database.transaction(async (transaction) => {
    await transaction.insert(billingProviderEvent).values({ provider: input.provider, providerEventId: input.providerEventId,
      providerSubscriptionId: input.providerSubscriptionId, type: input.type }).onConflictDoNothing();
    const [receipt] = await transaction.select({ status: billingProviderEvent.status, providerSubscriptionId: billingProviderEvent.providerSubscriptionId })
      .from(billingProviderEvent).where(receiptKey).for("update").limit(1);
    if (!receipt || receipt.providerSubscriptionId !== input.providerSubscriptionId) throw new Error("Billing event identity changed");
    if (receipt.status === "processed" || receipt.status === "superseded") return { duplicate: true };
    const [cursor] = await transaction.insert(billingSubscriptionReconciliation).values({ provider: input.provider,
      providerSubscriptionId: input.providerSubscriptionId, generation: 1 }).onConflictDoUpdate({
      target: [billingSubscriptionReconciliation.provider, billingSubscriptionReconciliation.providerSubscriptionId],
      set: { generation: sql`${billingSubscriptionReconciliation.generation} + 1`, updatedAt: new Date() },
    }).returning();
    if (!cursor || !Number.isSafeInteger(cursor.generation)) throw new Error("Billing reconciliation generation is invalid");
    return { duplicate: false, generation: cursor.generation };
  });
}

/** Preserve retry visibility without storing provider response bodies or keys. */
export async function markBillingReconciliationUnavailable(input: {
  databaseUrl: string;
  driver?: DatabaseDriver;
  provider: string;
  providerEventId: string;
}): Promise<void> {
  await createDatabase(outboxApplicationConnectionString(input.databaseUrl), input.driver).update(billingProviderEvent)
    .set({ status: "failed", error: "provider_unavailable" })
    .where(and(eq(billingProviderEvent.provider, input.provider), eq(billingProviderEvent.providerEventId, input.providerEventId),
      notInArray(billingProviderEvent.status, ["processed", "superseded"])));
}

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
  reconciliation?: { providerSubscriptionId: string; generation: number };
}): Promise<{ duplicate: boolean; superseded?: boolean }> {
  if (!input.provider || !input.providerEventId || !input.type) throw new Error("Invalid billing provider event identity");
  if (input.projection && !input.projection.providerSubscriptionId) throw new Error("Billing projection requires a provider subscription identity");
  if (input.reconciliation && (!input.projection || input.projection.providerSubscriptionId !== input.reconciliation.providerSubscriptionId || !Number.isSafeInteger(input.reconciliation.generation))) {
    throw new Error("Invalid billing reconciliation projection");
  }
  const database = createDatabase(outboxApplicationConnectionString(input.databaseUrl), input.driver);
  const key = and(eq(billingProviderEvent.provider, input.provider), eq(billingProviderEvent.providerEventId, input.providerEventId));
  await database.insert(billingProviderEvent).values({ provider: input.provider, providerEventId: input.providerEventId, type: input.type }).onConflictDoNothing();
  try {
    const scoped = input.projection ? createTenantDatabase(input.databaseUrl, input.driver, input.projection.organizationId) : database;
    return await scoped.transaction(async (transaction) => {
      if (input.projection) await transaction.execute(sql`select set_config('app.organization_id', ${input.projection.organizationId}, true)`);
      const [receipt] = await transaction.select({ status: billingProviderEvent.status, providerSubscriptionId: billingProviderEvent.providerSubscriptionId }).from(billingProviderEvent).where(key).for("update").limit(1);
      if (!receipt) throw new Error("Billing provider event receipt disappeared");
      if (receipt.status === "processed" || receipt.status === "superseded") return { duplicate: true };
      if (input.reconciliation) {
        if (receipt.providerSubscriptionId !== input.reconciliation.providerSubscriptionId) throw new Error("Billing event identity changed");
        const [cursor] = await transaction.select({ generation: billingSubscriptionReconciliation.generation })
          .from(billingSubscriptionReconciliation).where(and(eq(billingSubscriptionReconciliation.provider, input.provider),
            eq(billingSubscriptionReconciliation.providerSubscriptionId, input.reconciliation.providerSubscriptionId))).for("update").limit(1);
        if (!cursor) throw new Error("Billing reconciliation cursor disappeared");
        if (cursor.generation !== input.reconciliation.generation) {
          await transaction.update(billingProviderEvent).set({ status: "superseded", processedAt: new Date(), error: null }).where(key);
          return { duplicate: false, superseded: true };
        }
      }
      if (input.projection) {
        const value = input.projection;
        const providerSubscriptionId = value.providerSubscriptionId!;
        // Serialize all subscriptions targeting the same organization, even
        // when it has no projection row yet. A receipt lock only covers one
        // provider event and cannot prevent competing Checkout sessions.
        await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${value.organizationId}`}, 0))`);
        const ownershipKey = and(eq(billingSubscriptionOwnership.provider, input.provider),
          eq(billingSubscriptionOwnership.providerSubscriptionId, providerSubscriptionId));
        const inserted = await transaction.insert(billingSubscriptionOwnership).values({
          provider: input.provider, providerSubscriptionId, organizationId: value.organizationId,
        }).onConflictDoNothing().returning();
        const [owner] = await transaction.select({ organizationId: billingSubscriptionOwnership.organizationId })
          .from(billingSubscriptionOwnership).where(ownershipKey).limit(1);
        if (!owner || owner.organizationId !== value.organizationId) throw new Error("Billing subscription ownership conflict");
        const [current] = await transaction.select({ provider: organizationSubscription.provider,
          providerSubscriptionId: organizationSubscription.providerSubscriptionId, status: organizationSubscription.status })
          .from(organizationSubscription).where(eq(organizationSubscription.organizationId, value.organizationId)).for("update").limit(1);
        if (current?.providerSubscriptionId && (current.provider !== input.provider || current.providerSubscriptionId !== providerSubscriptionId)) {
          if (inserted.length === 0) {
            // An old subscription may still send valid provider events after a
            // replacement. It must never reactivate the replaced projection.
            await transaction.update(billingProviderEvent).set({ status: "superseded", processedAt: new Date(), error: null }).where(key);
            return { duplicate: false, superseded: true };
          }
          if (current.status !== "cancelled" && current.status !== "incomplete") {
            throw new Error("Active billing subscription cannot be replaced by another provider identity");
          }
        }
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
    await database.update(billingProviderEvent).set({ status: "failed", error: "projection_failed" })
      .where(and(key, notInArray(billingProviderEvent.status, ["processed", "superseded"]))).catch(() => undefined);
    throw error;
  }
}
