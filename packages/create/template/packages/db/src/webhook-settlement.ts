import { and, eq, gt, sql } from "drizzle-orm";

import type { Database } from "./index.js";
import { webhookAttempt } from "./webhook-attempt-schema.js";
import { webhookDelivery } from "./webhook-projection-schema.js";

export type NativeWebhookAttemptResult =
  | { kind: "response"; status: number }
  | { kind: "failure"; category: "timeout" | "network" | "tls" | "blocked_address" };

export type NativeWebhookSettlement =
  | { state: "stale" }
  | { state: "succeeded" | "retry" | "dead" | "exhausted"; attemptId: string; attemptNumber: number; nextRetryAt: Date | null };

const retryDelaysMs = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000] as const;

/** Deterministic ±10% jitter keeps retries spread out without test sleeps. */
export function nativeWebhookRetryDelayMs(deliveryId: string, attemptNumber: number): number {
  const nominal = retryDelaysMs[attemptNumber - 1];
  if (!nominal) throw new Error("Native webhook retry schedule is exhausted");
  let hash = 2166136261;
  for (const character of `${deliveryId}:${attemptNumber}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return Math.round(nominal * (0.9 + (hash / 0xffffffff) * 0.2));
}

/**
 * Persist a result only while this worker still owns a live lease. A timed-out
 * worker may have sent the request, but it cannot overwrite a recovered lease.
 * This is at-least-once delivery, not a claim of exactly-once network effects.
 */
export async function settleNativeWebhookAttempt(input: {
  organizationId: string;
  deliveryId: string;
  leaseToken: string;
  tenantDatabase: (organizationId: string) => Database;
  clock: { now(): Date };
  result: NativeWebhookAttemptResult;
  durationMs: number;
  maxAttempts?: number;
}): Promise<NativeWebhookSettlement> {
  const now = input.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invalid native webhook clock");
  if (!Number.isInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > 30_000) throw new Error("Invalid native webhook duration");
  const maxAttempts = input.maxAttempts ?? 7;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 7) throw new Error("Invalid native webhook maximum attempt count");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.leaseToken)) throw new Error("Invalid native webhook lease token");
  if (!input.result || !["response", "failure"].includes(input.result.kind)) throw new Error("Invalid native webhook result");
  if (input.result.kind === "response" && (!Number.isInteger(input.result.status) || input.result.status < 100 || input.result.status > 599)) throw new Error("Invalid native webhook HTTP status");
  if (input.result.kind === "failure" && !["timeout", "network", "tls", "blocked_address"].includes(input.result.category)) throw new Error("Invalid native webhook failure category");
  const database = input.tenantDatabase(input.organizationId);
  return database.transaction(async (transaction): Promise<NativeWebhookSettlement> => {
    const [current] = await transaction.select({ attemptCount: webhookDelivery.attemptCount })
      .from(webhookDelivery)
      .where(and(eq(webhookDelivery.id, input.deliveryId), eq(webhookDelivery.organizationId, input.organizationId), eq(webhookDelivery.state, "leased"), eq(webhookDelivery.leaseToken, input.leaseToken), gt(webhookDelivery.leasedUntil, now)))
      .limit(1);
    if (!current) return { state: "stale" };
    const attemptNumber = current.attemptCount + 1;
    const accepted = input.result.kind === "response" && input.result.status >= 200 && input.result.status < 300;
    const gone = input.result.kind === "response" && input.result.status === 410;
    const state = accepted ? "succeeded" : gone ? "dead" : attemptNumber >= maxAttempts ? "exhausted" : "retry";
    const nextRetryAt = state === "retry" ? new Date(now.getTime() + nativeWebhookRetryDelayMs(input.deliveryId, attemptNumber)) : null;
    const resultReason = input.result.kind === "response" ? `http_${input.result.status}` : input.result.category;
    const terminalReason = state === "dead" ? resultReason : state === "exhausted" ? `retry_exhausted:${resultReason}` : null;
    const [updated] = await transaction.update(webhookDelivery).set({
      state, attemptCount: sql`${webhookDelivery.attemptCount} + 1`, nextAttemptAt: nextRetryAt,
      leaseToken: null, leasedUntil: null, terminalReason, completedAt: state === "retry" ? null : now,
    }).where(and(
      eq(webhookDelivery.id, input.deliveryId), eq(webhookDelivery.organizationId, input.organizationId),
      eq(webhookDelivery.state, "leased"), eq(webhookDelivery.leaseToken, input.leaseToken),
      eq(webhookDelivery.attemptCount, current.attemptCount), gt(webhookDelivery.leasedUntil, now),
    )).returning();
    if (!updated) return { state: "stale" };
    const attemptId = `${input.deliveryId}.${attemptNumber}`;
    await transaction.insert(webhookAttempt).values({
      id: attemptId, organizationId: input.organizationId, deliveryId: input.deliveryId, attemptNumber,
      kind: "native", attemptedAt: new Date(now.getTime() - input.durationMs), completedAt: now,
      requestUrl: null, requestHeaders: {}, requestBody: null, simulatedStatus: null,
      responseStatus: input.result.kind === "response" ? input.result.status : null,
      resultCategory: input.result.kind === "response" ? "http" : input.result.category,
      outcome: state, durationMs: input.durationMs, nextRetryAt,
    });
    return { state, attemptId, attemptNumber, nextRetryAt };
  });
}
