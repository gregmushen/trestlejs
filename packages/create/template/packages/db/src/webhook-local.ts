import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";

import type { Database } from "./index.js";
import { webhookAttempt } from "./webhook-attempt-schema.js";
import { webhookDelivery, webhookMessage } from "./webhook-projection-schema.js";
import { webhookEndpoint } from "./webhook-schema.js";

export type LocalWebhookScenario =
  | { kind: "succeed"; status?: number; latencyMs?: number }
  | { kind: "fail"; status: number; latencyMs?: number }
  | { kind: "fail-times"; count: number; status: number; thenStatus?: number; latencyMs?: number }
  | { kind: "timeout"; latencyMs?: number };

export type LocalWebhookResult =
  | { state: "not_found" | "not_due" | "inactive" | "not_local" }
  | { state: "succeeded" | "retry" | "dead"; attemptId: string; attemptNumber: number; nextRetryAt: Date | null };

export class LocalWebhookError extends Error {
  constructor(message: string) { super(message); this.name = "LocalWebhookError"; }
}

function requireStatus(status: number): number {
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new LocalWebhookError("Invalid simulated HTTP status");
  return status;
}

function evaluateScenario(scenario: LocalWebhookScenario, attemptNumber: number): { status: number | null; durationMs: number } {
  const durationMs = scenario.latencyMs ?? 0;
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 30_000) throw new LocalWebhookError("Invalid simulated latency");
  if (scenario.kind === "timeout") return { status: null, durationMs: durationMs || 30_000 };
  if (scenario.kind === "succeed") {
    const status = requireStatus(scenario.status ?? 200);
    if (status >= 300) throw new LocalWebhookError("Success scenario requires a 2xx status");
    return { status, durationMs };
  }
  if (scenario.kind === "fail") {
    const status = requireStatus(scenario.status);
    if (status < 300) throw new LocalWebhookError("Failure scenario requires a non-2xx status");
    return { status, durationMs };
  }
  if (!Number.isInteger(scenario.count) || scenario.count < 0 || scenario.count > 100) throw new LocalWebhookError("Invalid failure count");
  const status = requireStatus(attemptNumber <= scenario.count ? scenario.status : (scenario.thenStatus ?? 200));
  if (scenario.status < 300 || (scenario.thenStatus ?? 200) >= 300) throw new LocalWebhookError("Invalid fail-then-succeed statuses");
  return { status, durationMs };
}

function retryDelayMs(attemptNumber: number): number {
  return Math.min(60 * 60 * 1_000, 1_000 * 2 ** Math.min(attemptNumber - 1, 12));
}

function decodeSigningSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (!secret.startsWith("whsec_")) throw new LocalWebhookError("Local signing secret must use the whsec_ format");
  try {
    const encoded = secret.slice(6);
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    if (bytes.length < 16 || btoa(String.fromCharCode(...bytes)) !== encoded) throw new Error("Invalid key material");
    return bytes;
  } catch {
    throw new LocalWebhookError("Local signing secret has invalid base64 key material");
  }
}

async function sign(id: string, timestamp: number, body: string, keyBytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...bytes))}`;
}

/** Local-only transport. It persists the signed request and scripted result but never calls fetch. */
export async function captureLocalWebhookDelivery(input: {
  organizationId: string;
  deliveryId: string;
  tenantDatabase: (organizationId: string) => Database;
  signingSecret: string;
  scenario: LocalWebhookScenario;
  clock: { now(): Date };
  maxAttempts?: number;
}): Promise<LocalWebhookResult> {
  const keyBytes = decodeSigningSecret(input.signingSecret);
  const maxAttempts = input.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new LocalWebhookError("Invalid maximum attempt count");
  const now = input.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new LocalWebhookError("Invalid local webhook clock");
  const database = input.tenantDatabase(input.organizationId);
  return database.transaction(async (transaction): Promise<LocalWebhookResult> => {
    const [record] = await transaction.select({
      delivery: webhookDelivery,
      envelope: webhookMessage.envelope,
      endpointUrl: webhookEndpoint.destinationUrl,
      endpointState: webhookEndpoint.state,
      endpointProvider: webhookEndpoint.provider,
      endpointEnvironment: webhookEndpoint.environment,
      endpointDeletedAt: webhookEndpoint.deletedAt,
    }).from(webhookDelivery)
      .innerJoin(webhookMessage, and(eq(webhookMessage.id, webhookDelivery.messageId), eq(webhookMessage.organizationId, webhookDelivery.organizationId)))
      .innerJoin(webhookEndpoint, and(eq(webhookEndpoint.id, webhookDelivery.endpointId), eq(webhookEndpoint.organizationId, webhookDelivery.organizationId)))
      .where(and(eq(webhookDelivery.id, input.deliveryId), eq(webhookDelivery.organizationId, input.organizationId))).limit(1);
    if (!record) return { state: "not_found" };
    if (record.endpointProvider !== "local" || record.endpointEnvironment !== "local") return { state: "not_local" };
    if (record.endpointState !== "active" || record.endpointDeletedAt) return { state: "inactive" };
    const due = record.delivery.nextAttemptAt && record.delivery.nextAttemptAt.getTime() <= now.getTime();
    if (!due || !["pending", "retry"].includes(record.delivery.state)) return { state: "not_due" };
    if (!record.envelope) throw new LocalWebhookError("Local delivery has no public payload");
    const attemptNumber = record.delivery.attemptCount + 1;
    const simulated = evaluateScenario(input.scenario, attemptNumber);
    const retryable = simulated.status === null || simulated.status === 408 || simulated.status === 429 || simulated.status >= 500;
    const state = simulated.status !== null && simulated.status >= 200 && simulated.status < 300 ? "succeeded" : retryable && attemptNumber < maxAttempts ? "retry" : "dead";
    const nextRetryAt = state === "retry" ? new Date(now.getTime() + retryDelayMs(attemptNumber)) : null;
    const body = JSON.stringify(record.envelope);
    const timestamp = Math.floor(now.getTime() / 1_000);
    const attemptId = `${record.delivery.id}.${attemptNumber}`;
    const headers = {
      "content-type": "application/json",
      "webhook-id": record.delivery.messageId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": await sign(record.delivery.messageId, timestamp, body, keyBytes),
    };
    const [claimed] = await transaction.update(webhookDelivery).set({
      state, attemptCount: attemptNumber, nextAttemptAt: nextRetryAt,
      terminalReason: state === "dead" ? (simulated.status === null ? "timeout" : `http_${simulated.status}`) : null,
      completedAt: state === "retry" ? null : now,
    }).where(and(eq(webhookDelivery.id, input.deliveryId), eq(webhookDelivery.organizationId, input.organizationId), inArray(webhookDelivery.state, ["pending", "retry"]), lte(webhookDelivery.nextAttemptAt, now))).returning();
    if (!claimed) return { state: "not_due" };
    await transaction.insert(webhookAttempt).values({
      id: attemptId, organizationId: input.organizationId, deliveryId: input.deliveryId,
      attemptNumber, kind: "local", attemptedAt: now, completedAt: new Date(now.getTime() + simulated.durationMs), requestUrl: record.endpointUrl, requestHeaders: headers,
      requestBody: body, simulatedStatus: simulated.status, outcome: state,
      durationMs: simulated.durationMs, nextRetryAt,
    });
    return { state, attemptId, attemptNumber, nextRetryAt };
  });
}

/** Bounded local retry sweep. The injected clock makes scheduled attempts
 * deterministic; this never performs an HTTP request. */
export async function flushDueLocalWebhookDeliveries(input: {
  organizationId: string;
  tenantDatabase: (organizationId: string) => Database;
  signingSecretForEndpoint: (endpointId: string) => Promise<string | null>;
  scenario: LocalWebhookScenario;
  clock: { now(): Date };
  limit?: number;
}): Promise<{ captured: number; skipped: number }> {
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new LocalWebhookError("Invalid local webhook flush limit");
  const now = input.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new LocalWebhookError("Invalid local webhook clock");
  const rows = await input.tenantDatabase(input.organizationId).select({
    deliveryId: webhookDelivery.id, endpointId: webhookDelivery.endpointId,
  }).from(webhookDelivery)
    .innerJoin(webhookEndpoint, and(eq(webhookEndpoint.id, webhookDelivery.endpointId), eq(webhookEndpoint.organizationId, webhookDelivery.organizationId)))
    .where(and(
      eq(webhookDelivery.organizationId, input.organizationId),
      inArray(webhookDelivery.state, ["pending", "retry"]),
      lte(webhookDelivery.nextAttemptAt, now),
      eq(webhookEndpoint.provider, "local"),
      eq(webhookEndpoint.environment, "local"),
      eq(webhookEndpoint.state, "active"),
      isNull(webhookEndpoint.deletedAt),
    )).orderBy(asc(webhookDelivery.nextAttemptAt), asc(webhookDelivery.id)).limit(limit);
  let captured = 0;
  let skipped = 0;
  for (const row of rows) {
    const signingSecret = await input.signingSecretForEndpoint(row.endpointId);
    if (!signingSecret) throw new LocalWebhookError("Local webhook endpoint has no current signing secret");
    const result = await captureLocalWebhookDelivery({
      organizationId: input.organizationId, deliveryId: row.deliveryId, tenantDatabase: input.tenantDatabase,
      signingSecret, scenario: input.scenario, clock: input.clock,
    });
    if (["succeeded", "retry", "dead"].includes(result.state)) captured++;
    else skipped++;
  }
  return { captured, skipped };
}
