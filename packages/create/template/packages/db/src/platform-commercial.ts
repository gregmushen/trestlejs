import { and, asc, desc, eq, isNull } from "drizzle-orm";

import { organization } from "./auth-schema.js";
import { recordAuditEvent } from "./audit.js";
import { organizationEntitlement, organizationEntitlementOverride, organizationSubscription } from "./billing-schema.js";
import type { Database } from "./index.js";
import { PlatformOperationError } from "./platform-operations.js";
import type { PlatformChangeContext } from "./platform-roles.js";

/**
 * Platform commercial controls on the trestle_platform connection. Overrides
 * are the only writable commercial record: the platform role may insert one and
 * tombstone an active one, while tenant runtimes can only read them. Internal
 * reasons and authors stay here and in audit; customer-facing provenance names
 * only the source.
 */
export type PlatformSubscriptionRow = Readonly<{ organizationId: string; organizationName: string; plan: string | null; planVersion: number | null; status: string | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean | null }>;

export async function listPlatformSubscriptions(database: Database, options: Readonly<{ limit?: number }> = {}): Promise<PlatformSubscriptionRow[]> {
  const limit = Math.min(Math.max(Math.trunc(Number.isFinite(options.limit) ? options.limit! : 100), 1), 200);
  return await database.select({
    organizationId: organization.id, organizationName: organization.name, plan: organizationSubscription.plan, planVersion: organizationSubscription.planVersion,
    status: organizationSubscription.status, currentPeriodEnd: organizationSubscription.currentPeriodEnd, cancelAtPeriodEnd: organizationSubscription.cancelAtPeriodEnd,
  }).from(organization).leftJoin(organizationSubscription, eq(organizationSubscription.organizationId, organization.id))
    .orderBy(asc(organization.name), asc(organization.id)).limit(limit);
}

export type PlatformEntitlementOverride = Readonly<{ entitlement: string; enabled: boolean; reason: string; authorId: string; effectiveAt: Date; expiresAt: Date | null; removedAt: Date | null; removedBy: string | null; removalReason: string | null }>;

export async function platformCommercialDetail(database: Database, organizationId: string) {
  const [subscription] = await database.select({
    provider: organizationSubscription.provider, plan: organizationSubscription.plan, planVersion: organizationSubscription.planVersion, status: organizationSubscription.status,
    currentPeriodStart: organizationSubscription.currentPeriodStart, currentPeriodEnd: organizationSubscription.currentPeriodEnd, cancelAtPeriodEnd: organizationSubscription.cancelAtPeriodEnd,
  }).from(organizationSubscription).where(eq(organizationSubscription.organizationId, organizationId)).limit(1);
  const entitlements = await database.select({ entitlement: organizationEntitlement.entitlement }).from(organizationEntitlement)
    .where(eq(organizationEntitlement.organizationId, organizationId)).orderBy(asc(organizationEntitlement.entitlement));
  const overrides: PlatformEntitlementOverride[] = await database.select({
    entitlement: organizationEntitlementOverride.entitlement, enabled: organizationEntitlementOverride.enabled, reason: organizationEntitlementOverride.reason,
    authorId: organizationEntitlementOverride.authorId, effectiveAt: organizationEntitlementOverride.effectiveAt, expiresAt: organizationEntitlementOverride.expiresAt,
    removedAt: organizationEntitlementOverride.removedAt, removedBy: organizationEntitlementOverride.removedBy, removalReason: organizationEntitlementOverride.removalReason,
  }).from(organizationEntitlementOverride).where(eq(organizationEntitlementOverride.organizationId, organizationId))
    .orderBy(desc(organizationEntitlementOverride.effectiveAt)).limit(100);
  return { subscription: subscription ?? null, planEntitlements: entitlements.map(({ entitlement }) => entitlement), overrides };
}

function requireReason(reason: string): string {
  const text = reason.trim();
  if (!text || text.length > 500) throw new PlatformOperationError("invalid", "A reason of at most 500 characters is required");
  return text;
}

const author = (context: PlatformChangeContext) => `${context.actor.type}:${context.actor.id}`;

/**
 * Grants or denies one entitlement for an organization, superseding any active
 * override for the same entitlement, and audits it on that organization.
 */
export async function grantEntitlementOverride(database: Database, input: Readonly<{ organizationId: string; entitlement: string; enabled: boolean; expiresAt?: Date }>, context: PlatformChangeContext): Promise<{ effectiveAt: Date }> {
  const reason = requireReason(context.reason);
  const now = context.now ?? new Date();
  if (input.expiresAt && input.expiresAt <= now) throw new PlatformOperationError("invalid", "An override must expire in the future");
  return await database.transaction(async (transaction) => {
    const [target] = await transaction.select({ id: organization.id }).from(organization).where(eq(organization.id, input.organizationId)).limit(1);
    if (!target) throw new PlatformOperationError("not_found", "The organization does not exist");
    // Overrides adjust a subscription's entitlements; without one they would silently do nothing.
    const [subscribed] = await transaction.select({ organizationId: organizationSubscription.organizationId }).from(organizationSubscription).where(eq(organizationSubscription.organizationId, input.organizationId)).limit(1);
    if (!subscribed) throw new PlatformOperationError("conflict", "The organization has no subscription, so an override would have no effect");
    const active = and(eq(organizationEntitlementOverride.organizationId, input.organizationId), eq(organizationEntitlementOverride.entitlement, input.entitlement), isNull(organizationEntitlementOverride.removedAt));
    const superseded = await transaction.select({ enabled: organizationEntitlementOverride.enabled }).from(organizationEntitlementOverride).where(active).for("update");
    if (superseded.length) await transaction.update(organizationEntitlementOverride).set({ removedAt: now, removedBy: author(context), removalReason: "superseded by a newer override" }).where(active);
    await transaction.insert(organizationEntitlementOverride).values({
      organizationId: input.organizationId, entitlement: input.entitlement, enabled: input.enabled, reason, authorId: author(context), effectiveAt: now, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    });
    await recordAuditEvent(transaction, {
      name: "platform.entitlement_override.granted", actor: context.actor, organizationId: input.organizationId, target: { type: "entitlement", id: input.entitlement },
      reason, summary: { enabled: input.enabled, expiresAt: input.expiresAt?.toISOString() ?? null, superseded: superseded.length },
      environment: context.environment, correlationId: context.correlationId, occurredAt: now,
    });
    return { effectiveAt: now };
  });
}

/** Tombstones the active override for an entitlement, restoring the plan's decision, and audits it. */
export async function revokeEntitlementOverride(database: Database, input: Readonly<{ organizationId: string; entitlement: string }>, context: PlatformChangeContext): Promise<void> {
  const reason = requireReason(context.reason);
  const now = context.now ?? new Date();
  await database.transaction(async (transaction) => {
    const [active] = await transaction.select({ enabled: organizationEntitlementOverride.enabled }).from(organizationEntitlementOverride)
      .where(and(eq(organizationEntitlementOverride.organizationId, input.organizationId), eq(organizationEntitlementOverride.entitlement, input.entitlement), isNull(organizationEntitlementOverride.removedAt)))
      .for("update").limit(1);
    if (!active) throw new PlatformOperationError("not_found", "The organization has no active override for this entitlement");
    await transaction.update(organizationEntitlementOverride).set({ removedAt: now, removedBy: author(context), removalReason: reason })
      .where(and(eq(organizationEntitlementOverride.organizationId, input.organizationId), eq(organizationEntitlementOverride.entitlement, input.entitlement), isNull(organizationEntitlementOverride.removedAt)));
    await recordAuditEvent(transaction, {
      name: "platform.entitlement_override.revoked", actor: context.actor, organizationId: input.organizationId, target: { type: "entitlement", id: input.entitlement },
      reason, summary: { enabled: active.enabled }, environment: context.environment, correlationId: context.correlationId, occurredAt: now,
    });
  });
}
