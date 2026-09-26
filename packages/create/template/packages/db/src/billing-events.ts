import { and, eq, lte, notInArray, sql } from "drizzle-orm";
import { applicationEventCatalog, eventEnvelopeSchema, type EventDefinition, type EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";

import { billingProviderEvent, billingSubscriptionOwnership, billingSubscriptionReconciliation, organizationEntitlement, organizationSubscription } from "./billing-schema.js";
import { createDatabase, createTenantDatabase, type DatabaseDriver } from "./index.js";
import { outboxApplicationConnectionString, outboxStatement, systemOutboxStatement } from "./outbox.js";

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

type Transaction = Parameters<Parameters<ReturnType<typeof createDatabase>["transaction"]>[0]>[0];
type Driver = { databaseUrl: string; driver?: DatabaseDriver };

/** Receipt states that a redelivery must never reopen. */
const settledReceiptStates = ["processed", "superseded", "rejected"];

/** Thrown inside the projection transaction so it rolls back. `ownership`
 * (the provider identity belongs to another organization) is terminal;
 * `replacement` (another subscription is still active) may resolve later. */
export class BillingProjectionConflict extends Error {
  constructor(readonly reason: "ownership" | "replacement") {
    super(reason === "ownership" ? "Billing subscription ownership conflict" : "Active billing subscription cannot be replaced by another provider identity");
    this.name = "BillingProjectionConflict";
  }
}

// --- Durable reconciliation request -------------------------------------------------

export const BILLING_RECONCILIATION_LEASE_MS = 60_000;
export type BillingReconciliationRequest = { provider: string; providerSubscriptionId: string; providerEventId: string; generation: number };
const providerPattern = /^[a-z][a-z0-9_-]{0,31}$/u;
const providerIdPattern = /^[A-Za-z0-9_-]{1,255}$/u;

/** A private, tenantless request to reconcile one provider subscription. It
 * names the work; the reconciler reads what is due from PostgreSQL. Register
 * its handler with `{ authority: "system" }`. It is never a public webhook. */
export const billingReconciliationRequestedEvent: EventDefinition<BillingReconciliationRequest> = {
  name: "billing.subscription.reconciliation_requested",
  schemaVersion: 1,
  parse(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid billing reconciliation request");
    const value = payload as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "generation,provider,providerEventId,providerSubscriptionId"
      || typeof value.provider !== "string" || !providerPattern.test(value.provider)
      || typeof value.providerSubscriptionId !== "string" || !providerIdPattern.test(value.providerSubscriptionId)
      || typeof value.providerEventId !== "string" || !providerIdPattern.test(value.providerEventId)
      || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1) throw new Error("Invalid billing reconciliation request");
    return { provider: value.provider, providerSubscriptionId: value.providerSubscriptionId, providerEventId: value.providerEventId, generation: value.generation as number };
  },
};

/**
 * Commit a verified subscription notification and a durable request to
 * reconcile it, in one transaction, without calling the provider. A webhook
 * may acknowledge once this returns. Each new receipt advances the
 * subscription's generation; a redelivered receipt reuses the generation it
 * already requested, and a settled receipt is a duplicate. The request is a
 * tenantless outbox event: tenant identity is decided later, from provider
 * state and the immutable ownership binding, never from the notification.
 */
export async function requestBillingSubscriptionReconciliation(input: Driver & {
  provider: string;
  providerEventId: string;
  providerSubscriptionId: string;
  type: string;
  correlationId: string;
}): Promise<{ duplicate: true } | { duplicate: false; generation: number; request: EventEnvelope | null }> {
  if (!providerPattern.test(input.provider) || !providerIdPattern.test(input.providerEventId) || !providerIdPattern.test(input.providerSubscriptionId)
    || !input.type.startsWith("Subscription") || !input.correlationId.trim() || input.correlationId.length > 128) throw new Error("Invalid billing reconciliation identity");
  const database = createDatabase(outboxApplicationConnectionString(input.databaseUrl), input.driver);
  const receiptKey = and(eq(billingProviderEvent.provider, input.provider), eq(billingProviderEvent.providerEventId, input.providerEventId));
  return await database.transaction(async (transaction) => {
    await transaction.insert(billingProviderEvent).values({ provider: input.provider, providerEventId: input.providerEventId,
      providerSubscriptionId: input.providerSubscriptionId, type: input.type }).onConflictDoNothing();
    const [receipt] = await transaction.select({ status: billingProviderEvent.status, providerSubscriptionId: billingProviderEvent.providerSubscriptionId,
      generation: billingProviderEvent.reconciliationGeneration }).from(billingProviderEvent).where(receiptKey).for("update").limit(1);
    if (!receipt || receipt.providerSubscriptionId !== input.providerSubscriptionId) throw new Error("Billing event identity changed");
    if (settledReceiptStates.includes(receipt.status)) return { duplicate: true };
    if (receipt.generation !== null) return { duplicate: false, generation: receipt.generation, request: null };
    const requested = { requestedEventId: input.providerEventId, requestedEventType: input.type, requestedCorrelationId: input.correlationId, updatedAt: new Date() };
    const [cursor] = await transaction.insert(billingSubscriptionReconciliation).values({ provider: input.provider,
      providerSubscriptionId: input.providerSubscriptionId, generation: 1, ...requested }).onConflictDoUpdate({
      target: [billingSubscriptionReconciliation.provider, billingSubscriptionReconciliation.providerSubscriptionId],
      set: { generation: sql`${billingSubscriptionReconciliation.generation} + 1`, ...requested },
    }).returning();
    if (!cursor || !Number.isSafeInteger(cursor.generation)) throw new Error("Billing reconciliation generation is invalid");
    await transaction.update(billingProviderEvent).set({ reconciliationGeneration: cursor.generation }).where(receiptKey);
    const payload = billingReconciliationRequestedEvent.parse({ provider: input.provider, providerSubscriptionId: input.providerSubscriptionId,
      providerEventId: input.providerEventId, generation: cursor.generation });
    const request = eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: billingReconciliationRequestedEvent.name,
      schemaVersion: billingReconciliationRequestedEvent.schemaVersion, occurredAt: new Date().toISOString(),
      resource: { type: "billing_subscription", id: `${input.provider}:${input.providerSubscriptionId}` },
      correlationId: input.correlationId, causationId: input.providerEventId,
      idempotencyKey: `billing-reconcile:${input.provider}:${input.providerEventId}`, payload });
    await transaction.execute(systemOutboxStatement(request));
    return { duplicate: false, generation: cursor.generation, request };
  });
}

/** The right to reconcile one subscription up to `generation`. Only the
 * holder of `token` can commit; a newer claim after lease expiry fences it. */
export type BillingReconciliationClaim = Readonly<{
  provider: string;
  providerSubscriptionId: string;
  token: string;
  generation: number;
  providerEventId: string;
  type: string;
  correlationId: string;
  occurredAt: Date;
}>;

/**
 * Take the lease on a due subscription before the provider is called. Returns
 * `idle` when nothing is due and `busy` while another live lease exists. The
 * transaction ends before the caller contacts the provider.
 */
export async function claimBillingSubscriptionReconciliation(input: Driver & {
  provider: string;
  providerSubscriptionId: string;
  leaseMs?: number;
}): Promise<{ state: "idle" } | { state: "busy" } | { state: "claimed"; claim: BillingReconciliationClaim }> {
  const leaseMs = input.leaseMs ?? BILLING_RECONCILIATION_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 15 * 60_000) throw new Error("Invalid billing reconciliation lease");
  const database = createDatabase(outboxApplicationConnectionString(input.databaseUrl), input.driver);
  return await database.transaction(async (transaction) => {
    const [cursor] = await transaction.select({ generation: billingSubscriptionReconciliation.generation,
      reconciled: billingSubscriptionReconciliation.reconciledGeneration, eventId: billingSubscriptionReconciliation.requestedEventId,
      type: billingSubscriptionReconciliation.requestedEventType, correlationId: billingSubscriptionReconciliation.requestedCorrelationId,
      leased: sql<boolean>`(${billingSubscriptionReconciliation.leaseToken} is not null and ${billingSubscriptionReconciliation.leaseExpiresAt} > now())` })
      .from(billingSubscriptionReconciliation).where(cursorKey(input.provider, input.providerSubscriptionId)).for("update").limit(1);
    if (!cursor || cursor.reconciled >= cursor.generation) return { state: "idle" as const };
    if (cursor.leased) return { state: "busy" as const };
    if (!cursor.eventId || !cursor.type || !cursor.correlationId) throw new Error("Billing reconciliation request is incomplete");
    const token = crypto.randomUUID();
    await transaction.update(billingSubscriptionReconciliation).set({ leaseToken: token, leaseGeneration: cursor.generation,
      leaseExpiresAt: sql`now() + (${leaseMs} * interval '1 millisecond')`, attempts: sql`${billingSubscriptionReconciliation.attempts} + 1`, updatedAt: new Date() })
      .where(cursorKey(input.provider, input.providerSubscriptionId));
    const [receipt] = await transaction.select({ receivedAt: billingProviderEvent.receivedAt }).from(billingProviderEvent)
      .where(and(eq(billingProviderEvent.provider, input.provider), eq(billingProviderEvent.providerEventId, cursor.eventId))).limit(1);
    return { state: "claimed" as const, claim: { provider: input.provider, providerSubscriptionId: input.providerSubscriptionId, token,
      generation: cursor.generation, providerEventId: cursor.eventId, type: cursor.type, correlationId: cursor.correlationId,
      occurredAt: receipt?.receivedAt ?? new Date() } };
  });
}

export type BillingReconciliationOutcome = "applied" | "superseded" | "not_found" | "unmapped" | "ownership_conflict" | "replacement_conflict" | "unavailable" | "fenced";
export type BillingReconciliationResult =
  | { kind: "current"; projection: BillingWebhookProjection }
  | { kind: "terminal"; reason: "not_found" | "unmapped" }
  | { kind: "unavailable" };

const terminalReceiptErrors = { not_found: "provider_subscription_not_found", unmapped: "subscription_unmapped", ownership_conflict: "ownership_conflict" } as const;

/**
 * Commit what the provider reported for a claim, only while the claim still
 * holds the lease. `current` replaces the subscription, entitlements and
 * billing event atomically; `terminal` rejects the covered receipts and keeps
 * the last confirmed projection; `unavailable` releases the lease and leaves
 * the work due. `due` reports whether a newer receipt arrived meanwhile.
 * A projection failure releases the lease, keeps the work due and rethrows.
 */
export async function completeBillingSubscriptionReconciliation(input: Driver & {
  claim: BillingReconciliationClaim;
  result: BillingReconciliationResult;
}): Promise<{ outcome: BillingReconciliationOutcome; due: boolean }> {
  const { claim, result } = input;
  if (result.kind === "unavailable") return await releaseClaim(input, "provider_unavailable");
  if (result.kind === "terminal") return await rejectClaim(input, result.reason);
  const projection = result.projection;
  if (projection.providerSubscriptionId !== claim.providerSubscriptionId) throw new Error("Billing reconciliation projection changed identity");
  try {
    const scoped = createTenantDatabase(input.databaseUrl, input.driver, projection.organizationId);
    return await scoped.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('app.organization_id', ${projection.organizationId}, true)`);
      if (!await holdsLease(transaction, claim)) return { outcome: "fenced" as const, due: false };
      const projected = await projectSubscription(transaction, { provider: claim.provider, providerEventId: claim.providerEventId,
        type: claim.type, correlationId: claim.correlationId, projection });
      await settleReceipts(transaction, claim, projected === "applied" ? "processed" : "superseded");
      return { outcome: projected, due: await finishClaim(transaction, claim, projected) };
    });
  } catch (error) {
    if (error instanceof BillingProjectionConflict && error.reason === "ownership") return await rejectClaim(input, "ownership_conflict");
    const released = await releaseClaim(input, error instanceof BillingProjectionConflict ? "replacement_conflict" : "projection_failed").catch(() => undefined);
    if (released?.outcome === "fenced") return released;
    throw error;
  }
}

function cursorKey(provider: string, providerSubscriptionId: string) {
  return and(eq(billingSubscriptionReconciliation.provider, provider), eq(billingSubscriptionReconciliation.providerSubscriptionId, providerSubscriptionId));
}

async function holdsLease(transaction: Transaction, claim: BillingReconciliationClaim): Promise<boolean> {
  const [cursor] = await transaction.select({ token: billingSubscriptionReconciliation.leaseToken }).from(billingSubscriptionReconciliation)
    .where(cursorKey(claim.provider, claim.providerSubscriptionId)).for("update").limit(1);
  return cursor?.token === claim.token;
}

/** Settle every open receipt the claim covered. With `processed`, the receipt
 * whose request the claim answered is processed and older ones superseded. */
async function settleReceipts(transaction: Transaction, claim: BillingReconciliationClaim, mode: "processed" | "superseded" | "rejected" | "failed", error: string | null = null): Promise<void> {
  const status = mode === "processed"
    ? sql`case when ${billingProviderEvent.providerEventId} = ${claim.providerEventId} then 'processed' else 'superseded' end`
    : sql`${mode}`;
  await transaction.update(billingProviderEvent).set({ status, error, ...(mode === "failed" ? {} : { processedAt: new Date() }) })
    .where(and(eq(billingProviderEvent.provider, claim.provider), eq(billingProviderEvent.providerSubscriptionId, claim.providerSubscriptionId),
      lte(billingProviderEvent.reconciliationGeneration, claim.generation), notInArray(billingProviderEvent.status, settledReceiptStates)));
}

async function finishClaim(transaction: Transaction, claim: BillingReconciliationClaim, outcome: BillingReconciliationOutcome): Promise<boolean> {
  const [cursor] = await transaction.update(billingSubscriptionReconciliation).set({
    reconciledGeneration: sql`greatest(${billingSubscriptionReconciliation.reconciledGeneration}, ${claim.generation})`,
    leaseToken: null, leaseGeneration: null, leaseExpiresAt: null, lastOutcome: outcome, lastError: null, updatedAt: new Date(),
  }).where(cursorKey(claim.provider, claim.providerSubscriptionId)).returning();
  return (cursor?.generation ?? 0) > claim.generation;
}

async function rejectClaim(input: Driver & { claim: BillingReconciliationClaim }, reason: keyof typeof terminalReceiptErrors): Promise<{ outcome: BillingReconciliationOutcome; due: boolean }> {
  const database = createDatabase(outboxApplicationConnectionString(input.databaseUrl), input.driver);
  return await database.transaction(async (transaction) => {
    if (!await holdsLease(transaction, input.claim)) return { outcome: "fenced" as const, due: false };
    await settleReceipts(transaction, input.claim, "rejected", terminalReceiptErrors[reason]);
    return { outcome: reason, due: await finishClaim(transaction, input.claim, reason) };
  });
}

async function releaseClaim(input: Driver & { claim: BillingReconciliationClaim }, error: "provider_unavailable" | "projection_failed" | "replacement_conflict"): Promise<{ outcome: BillingReconciliationOutcome; due: boolean }> {
  const database = createDatabase(outboxApplicationConnectionString(input.databaseUrl), input.driver);
  return await database.transaction(async (transaction) => {
    if (!await holdsLease(transaction, input.claim)) return { outcome: "fenced" as const, due: false };
    await settleReceipts(transaction, input.claim, "failed", error);
    await transaction.update(billingSubscriptionReconciliation).set({ leaseToken: null, leaseGeneration: null, leaseExpiresAt: null,
      lastError: error, updatedAt: new Date() }).where(cursorKey(input.claim.provider, input.claim.providerSubscriptionId));
    return { outcome: "unavailable" as const, due: true };
  });
}

// --- Projection ---------------------------------------------------------------------

/**
 * Replace one organization's subscription projection, entitlements and
 * billing event inside the caller's tenant transaction. Returns `superseded`
 * for a late event from a subscription that was already replaced; throws
 * `BillingProjectionConflict` (rolling back) for an ownership or replacement
 * conflict. Receipt status is the caller's responsibility.
 */
async function projectSubscription(transaction: Transaction, input: { provider: string; providerEventId: string; type: string; correlationId?: string; projection: BillingWebhookProjection }): Promise<"applied" | "superseded"> {
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
  if (!owner || owner.organizationId !== value.organizationId) throw new BillingProjectionConflict("ownership");
  const [current] = await transaction.select({ provider: organizationSubscription.provider,
    providerSubscriptionId: organizationSubscription.providerSubscriptionId, status: organizationSubscription.status,
    plan: organizationSubscription.plan })
    .from(organizationSubscription).where(eq(organizationSubscription.organizationId, value.organizationId)).for("update").limit(1);
  if (current?.providerSubscriptionId && (current.provider !== input.provider || current.providerSubscriptionId !== providerSubscriptionId)) {
    // An old subscription may still send valid provider events after a
    // replacement. It must never reactivate the replaced projection.
    if (inserted.length === 0) return "superseded";
    if (current.status !== "cancelled" && current.status !== "incomplete") throw new BillingProjectionConflict("replacement");
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
  const name = value.status === "cancelled" ? "billing.subscription.cancelled"
    : value.status === "past_due" ? "billing.subscription.past_due"
    : input.type === "SubscriptionActivated" ? "billing.subscription.activated" : "billing.subscription.updated";
  const payload = applicationEventCatalog.parse(name, 1, {
    organizationId: value.organizationId, plan: value.plan, planVersion: value.planVersion,
    status: value.status, entitlements: [...value.entitlements],
    ...(current ? { previousPlan: current.plan, previousStatus: current.status } : {}),
    cancelAtPeriodEnd: value.cancelAtPeriodEnd ?? value.status === "cancelled",
    ...(value.currentPeriodEnd ? { currentPeriodEnd: value.currentPeriodEnd.toISOString() } : {}),
  });
  const envelope = eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name, schemaVersion: 1,
    occurredAt: updatedAt.toISOString(), resource: applicationEventCatalog.resource(name, 1, payload),
    correlationId: input.correlationId ?? input.providerEventId, causationId: input.providerEventId,
    idempotencyKey: `billing:${input.provider}:${input.providerEventId}`, payload });
  await transaction.execute(outboxStatement(envelope, value.organizationId));
  return "applied";
}

/** Project one provider event directly: the receipt, projection, entitlements
 * and billing event commit together, and the receipt row lock serializes
 * duplicate deliveries. Subscription notifications from a provider go through
 * `requestBillingSubscriptionReconciliation` instead; this is the projection
 * primitive for trusted, already-current state. */
export async function applyBillingProviderEvent(input: Driver & {
  provider: string;
  providerEventId: string;
  type: string;
  correlationId?: string;
  projection?: BillingWebhookProjection;
}): Promise<{ duplicate: boolean; superseded?: boolean }> {
  if (!input.provider || !input.providerEventId || !input.type) throw new Error("Invalid billing provider event identity");
  if (input.projection && !input.projection.providerSubscriptionId) throw new Error("Billing projection requires a provider subscription identity");
  const database = createDatabase(outboxApplicationConnectionString(input.databaseUrl), input.driver);
  const key = and(eq(billingProviderEvent.provider, input.provider), eq(billingProviderEvent.providerEventId, input.providerEventId));
  await database.insert(billingProviderEvent).values({ provider: input.provider, providerEventId: input.providerEventId, type: input.type }).onConflictDoNothing();
  try {
    const scoped = input.projection ? createTenantDatabase(input.databaseUrl, input.driver, input.projection.organizationId) : database;
    return await scoped.transaction(async (transaction) => {
      if (input.projection) await transaction.execute(sql`select set_config('app.organization_id', ${input.projection.organizationId}, true)`);
      const [receipt] = await transaction.select({ status: billingProviderEvent.status }).from(billingProviderEvent).where(key).for("update").limit(1);
      if (!receipt) throw new Error("Billing provider event receipt disappeared");
      if (settledReceiptStates.includes(receipt.status)) return { duplicate: true };
      if (input.projection) {
        const projected = await projectSubscription(transaction, { provider: input.provider, providerEventId: input.providerEventId, type: input.type,
          ...(input.correlationId ? { correlationId: input.correlationId } : {}), projection: input.projection });
        if (projected === "superseded") {
          await transaction.update(billingProviderEvent).set({ status: "superseded", processedAt: new Date(), error: null }).where(key);
          return { duplicate: false, superseded: true };
        }
      }
      await transaction.update(billingProviderEvent).set({ status: "processed", processedAt: new Date(), error: null }).where(key);
      return { duplicate: false };
    });
  } catch (error) {
    await database.update(billingProviderEvent).set({ status: "failed", error: "projection_failed" })
      .where(and(key, notInArray(billingProviderEvent.status, settledReceiptStates))).catch(() => undefined);
    throw error;
  }
}

/** Checkout and invoice notifications may arrive before the subscription
 * webhook. Their metadata is only a tenant candidate: the immutable local
 * binding must confirm it before an internal event can be acknowledged. */
export async function applyBillingNotificationEvent(input: {
  databaseUrl: string;
  driver?: DatabaseDriver;
  provider: string;
  providerEventId: string;
  providerSubscriptionId: string;
  providerCustomerId?: string;
  type: "BillingCheckoutCompleted" | "InvoicePaid" | "InvoicePaymentFailed";
  organizationId?: string;
  correlationId: string;
  occurredAt: Date;
  paymentStatus?: "paid" | "unpaid" | "no_payment_required";
  amountMinor?: number;
  currency?: string;
}): Promise<{ duplicate: boolean; unresolved?: boolean }> {
  if (!input.provider || !input.providerEventId || !input.providerSubscriptionId.startsWith("sub_")
    || !input.correlationId.trim() || !Number.isFinite(input.occurredAt.getTime())) throw new Error("Invalid billing notification identity");
  const database = createDatabase(outboxApplicationConnectionString(input.databaseUrl), input.driver);
  const key = and(eq(billingProviderEvent.provider, input.provider), eq(billingProviderEvent.providerEventId, input.providerEventId));
  await database.insert(billingProviderEvent).values({ provider: input.provider, providerEventId: input.providerEventId,
    providerSubscriptionId: input.providerSubscriptionId, type: input.type }).onConflictDoNothing();
  if (!input.organizationId || !/^[A-Za-z0-9_-]+$/u.test(input.organizationId)) {
    const [existing] = await database.select({ status: billingProviderEvent.status,
      providerSubscriptionId: billingProviderEvent.providerSubscriptionId }).from(billingProviderEvent).where(key).limit(1);
    if (existing?.providerSubscriptionId !== input.providerSubscriptionId) throw new Error("Billing notification identity changed");
    if (existing.status === "processed") return { duplicate: true };
    await database.update(billingProviderEvent).set({ status: "failed", error: "ownership_unresolved" })
      .where(and(key, notInArray(billingProviderEvent.status, ["processed", "superseded"])));
    return { duplicate: false, unresolved: true };
  }
  try {
    const scoped = createTenantDatabase(input.databaseUrl, input.driver, input.organizationId);
    return await scoped.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('app.organization_id', ${input.organizationId}, true)`);
      const [receipt] = await transaction.select({ status: billingProviderEvent.status,
        providerSubscriptionId: billingProviderEvent.providerSubscriptionId })
        .from(billingProviderEvent).where(key).for("update").limit(1);
      if (!receipt || receipt.providerSubscriptionId !== input.providerSubscriptionId) {
        throw new Error("Billing notification identity changed");
      }
      if (receipt.status === "processed") return { duplicate: true };
      const [owner] = await transaction.select({ organizationId: billingSubscriptionOwnership.organizationId })
        .from(billingSubscriptionOwnership).where(and(eq(billingSubscriptionOwnership.provider, input.provider),
          eq(billingSubscriptionOwnership.providerSubscriptionId, input.providerSubscriptionId))).limit(1);
      if (!owner || owner.organizationId !== input.organizationId) {
        await transaction.update(billingProviderEvent).set({ status: "failed", error: "ownership_unresolved" }).where(key);
        return { duplicate: false, unresolved: true };
      }
      const [current] = await transaction.select({ provider: organizationSubscription.provider,
        providerSubscriptionId: organizationSubscription.providerSubscriptionId,
        providerCustomerId: organizationSubscription.providerCustomerId })
        .from(organizationSubscription).where(eq(organizationSubscription.organizationId, input.organizationId)).for("update").limit(1);
      const currentSubscription = current?.provider === input.provider && current.providerSubscriptionId === input.providerSubscriptionId;
      if (currentSubscription && input.providerCustomerId && current?.providerCustomerId
        && current.providerCustomerId !== input.providerCustomerId) {
        await transaction.update(billingProviderEvent).set({ status: "failed", error: "ownership_unresolved" }).where(key);
        return { duplicate: false, unresolved: true };
      }
      const name = input.type === "BillingCheckoutCompleted" ? "billing.checkout.completed"
        : input.type === "InvoicePaid" ? "billing.invoice.paid" : "billing.invoice.payment_failed";
      const payload = applicationEventCatalog.parse(name, 1, input.type === "BillingCheckoutCompleted"
        ? { organizationId: input.organizationId, currentSubscription,
          ...(input.paymentStatus ? { paymentStatus: input.paymentStatus } : {}) }
        : { organizationId: input.organizationId, currentSubscription,
          amountMinor: input.amountMinor, currency: input.currency });
      const envelope = eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name, schemaVersion: 1,
        occurredAt: input.occurredAt.toISOString(), resource: applicationEventCatalog.resource(name, 1, payload),
        correlationId: input.correlationId, causationId: input.providerEventId,
        idempotencyKey: `billing:${input.provider}:${input.providerEventId}`, payload });
      await transaction.execute(outboxStatement(envelope, input.organizationId));
      await transaction.update(billingProviderEvent).set({ status: "processed", processedAt: new Date(), error: null }).where(key);
      return { duplicate: false };
    });
  } catch (error) {
    await database.update(billingProviderEvent).set({ status: "failed", error: "notification_failed" })
      .where(and(key, notInArray(billingProviderEvent.status, ["processed", "superseded"]))).catch(() => undefined);
    throw error;
  }
}
