import { and, count, eq, gt, inArray, lte, or } from "drizzle-orm";

import type { Database } from "./index.js";
import { webhookDelivery } from "./webhook-projection-schema.js";
import { webhookEndpoint } from "./webhook-schema.js";

export type NativeWebhookClaimResult =
  | { state: "not_found" | "not_native" | "inactive" | "not_due" | "capacity" }
  | { state: "leased"; deliveryId: string; organizationId: string; leaseToken: string; leasedUntil: Date; attemptNumber: number };

/**
 * Claim a known delivery ID after its tenant provenance has been reloaded from
 * PostgreSQL. Never pass an organization ID supplied by a Queue envelope.
 * The conditional UPDATE is the concurrency boundary: duplicate wake-ups and
 * recovery sweeps cannot both own a live lease.
 */
export async function claimNativeWebhookDelivery(input: {
  organizationId: string;
  deliveryId: string;
  tenantDatabase: (organizationId: string) => Database;
  clock: { now(): Date };
  leaseMs?: number;
  maxActivePerEndpoint?: number;
}): Promise<NativeWebhookClaimResult> {
  const leaseMs = input.leaseMs ?? 30_000;
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 5 * 60_000) throw new Error("Invalid native webhook lease duration");
  const maxActivePerEndpoint = input.maxActivePerEndpoint ?? 4;
  if (!Number.isInteger(maxActivePerEndpoint) || maxActivePerEndpoint < 1 || maxActivePerEndpoint > 32) throw new Error("Invalid native webhook endpoint concurrency limit");
  const now = input.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invalid native webhook clock");
  const database = input.tenantDatabase(input.organizationId);
  return database.transaction(async (transaction): Promise<NativeWebhookClaimResult> => {
    const [record] = await transaction.select({
      endpointId: webhookEndpoint.id,
      provider: webhookEndpoint.provider,
      environment: webhookEndpoint.environment,
      endpointState: webhookEndpoint.state,
      deletedAt: webhookEndpoint.deletedAt,
      deliveryState: webhookDelivery.state,
      nextAttemptAt: webhookDelivery.nextAttemptAt,
      leasedUntil: webhookDelivery.leasedUntil,
    }).from(webhookDelivery)
      .innerJoin(webhookEndpoint, and(eq(webhookEndpoint.id, webhookDelivery.endpointId), eq(webhookEndpoint.organizationId, webhookDelivery.organizationId)))
      .where(and(eq(webhookDelivery.id, input.deliveryId), eq(webhookDelivery.organizationId, input.organizationId))).limit(1).for("update", { of: webhookEndpoint });
    if (!record) return { state: "not_found" };
    if (record.provider !== "native" || record.environment === "local") return { state: "not_native" };
    if (record.endpointState !== "active" || record.deletedAt) return { state: "inactive" };
    const due = record.deliveryState === "leased"
      ? Boolean(record.leasedUntil && record.leasedUntil <= now)
      : (record.deliveryState === "pending" || record.deliveryState === "retry") && Boolean(record.nextAttemptAt && record.nextAttemptAt <= now);
    if (!due) return { state: "not_due" };
    const [active] = await transaction.select({ total: count() }).from(webhookDelivery).where(and(
      eq(webhookDelivery.organizationId, input.organizationId), eq(webhookDelivery.endpointId, record.endpointId),
      eq(webhookDelivery.state, "leased"), gt(webhookDelivery.leasedUntil, now),
    ));
    if ((active?.total ?? 0) >= maxActivePerEndpoint) return { state: "capacity" };
    const leaseToken = crypto.randomUUID();
    const leasedUntil = new Date(now.getTime() + leaseMs);
    const [claimed] = await transaction.update(webhookDelivery)
      .set({ state: "leased", leaseToken, leasedUntil })
      .where(and(
        eq(webhookDelivery.id, input.deliveryId), eq(webhookDelivery.organizationId, input.organizationId),
        or(
          and(inArray(webhookDelivery.state, ["pending", "retry"]), lte(webhookDelivery.nextAttemptAt, now)),
          and(eq(webhookDelivery.state, "leased"), lte(webhookDelivery.leasedUntil, now)),
        ),
      )).returning();
    return claimed
      ? { state: "leased", deliveryId: claimed.id, organizationId: claimed.organizationId, leaseToken, leasedUntil, attemptNumber: claimed.attemptCount + 1 }
      : { state: "not_due" };
  });
}
