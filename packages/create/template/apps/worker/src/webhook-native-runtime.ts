import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createLogger, loggerSecretsFromEnvironment } from "@__TRESTLE_PROJECT_NAME__/context";
import { claimNativeWebhookDelivery, createSignedWebhookHeaders, createTenantDatabase, expireNativeWebhookDelivery, loadCurrentWebhookSigningSecret, loadNativeWebhookAttempt, resolveNativeWebhookWork, settleNativeWebhookAttempt, type Database, type NativeWebhookWakeup } from "@__TRESTLE_PROJECT_NAME__/db";
import type { OutboxEntry } from "@__TRESTLE_PROJECT_NAME__/events";

import { sendNativeWebhook, type NativeWebhookTransportResult } from "./webhook-transport.js";

export type NativeWebhookRunResult =
  | { state: "ignored" | "stale" | "succeeded" | "dead" | "exhausted" }
  | { state: "retry"; delaySeconds: number };

/** Reacquire organization authority from the committed outbox row, then use
 * the fenced delivery lease for exactly one network attempt. */
export async function runNativeWebhookWakeup(input: {
  wakeup: NativeWebhookWakeup;
  environment: AuthEnvironment;
  outbox: { findCommitted(id: string): Promise<OutboxEntry | null> };
  tenantDatabase?: (organizationId: string) => Database;
  send?: typeof sendNativeWebhook;
  clock?: { now(): Date };
}): Promise<NativeWebhookRunResult> {
  const environment = input.environment.APP_ENV;
  if (input.environment.WEBHOOK_DELIVERY_MODE !== "native" || !environment || environment === "local") {
    throw new Error("Native webhook delivery requires a remote native environment");
  }
  const masterKey = input.environment.WEBHOOK_SECRET_KEY;
  if (!masterKey) throw new Error("Native webhook signing key is not configured");
  const tenantDatabase = input.tenantDatabase ?? ((organizationId: string) => createTenantDatabase(input.environment.DATABASE_URL, input.environment.DATABASE_DRIVER, organizationId));
  const clock = input.clock ?? { now: () => new Date() };
  const work = await resolveNativeWebhookWork({ wakeup: input.wakeup, environment, outbox: input.outbox, tenantDatabase, now: clock.now() });
  if (work.state === "expired") {
    // Verification will refuse this event from now on, so settle the delivery
    // rather than leave it in retry. A live lease is left to its attempt.
    const settled = await expireNativeWebhookDelivery({ organizationId: work.organizationId, deliveryId: work.deliveryId, tenantDatabase, now: clock.now() });
    if (settled) createLogger({ organizationId: work.organizationId }, undefined, { secretValues: loggerSecretsFromEnvironment(input.environment) }).warn("webhook.native.delivery.expired", { webhookDeliveryId: work.deliveryId, reason: "provenance_expired" });
    return { state: settled ? "exhausted" : "ignored" };
  }
  if (work.state !== "ready") return { state: "ignored" };
  const claim = await claimNativeWebhookDelivery({ organizationId: work.organizationId, deliveryId: work.deliveryId, tenantDatabase, clock, leaseMs: 60_000 });
  if (claim.state === "capacity") {
    createLogger({ organizationId: work.organizationId }, undefined, { secretValues: loggerSecretsFromEnvironment(input.environment) }).info("webhook.native.capacity.deferred", { webhookDeliveryId: work.deliveryId });
    return { state: "retry", delaySeconds: 30 };
  }
  if (claim.state !== "leased") return { state: "ignored" };
  const payload = await loadNativeWebhookAttempt({ organizationId: work.organizationId, deliveryId: work.deliveryId, leaseToken: claim.leaseToken, environment, tenantDatabase, clock });
  if (!payload) return { state: "stale" };
  const signingSecret = await loadCurrentWebhookSigningSecret({ tenantDatabase, masterKey, environment, organizationId: work.organizationId, endpointId: payload.endpointId });
  if (!signingSecret) throw new Error("Native webhook endpoint has no current signing secret");
  const headers = await createSignedWebhookHeaders({ secret: signingSecret, messageId: payload.messageId, body: payload.body, now: clock.now() });
  const sent: NativeWebhookTransportResult = await (input.send ?? sendNativeWebhook)({ destinationUrl: payload.destinationUrl, body: payload.body, headers });
  const settled = await settleNativeWebhookAttempt({
    organizationId: work.organizationId, deliveryId: work.deliveryId, leaseToken: claim.leaseToken,
    tenantDatabase, clock, result: sent.kind === "response" ? { kind: "response", status: sent.status } : { kind: "failure", category: sent.category }, durationMs: sent.durationMs,
  });
  if (settled.state === "stale") return { state: "stale" };
  createLogger({ correlationId: payload.correlationId, organizationId: work.organizationId }, undefined, { secretValues: loggerSecretsFromEnvironment(input.environment) }).info("webhook.native.attempt.settled", {
    webhookDeliveryId: work.deliveryId, state: settled.state, attemptNumber: settled.attemptNumber,
  });
  if (settled.state !== "retry") return { state: settled.state };
  const delaySeconds = Math.max(1, Math.min(86_400, Math.ceil((settled.nextRetryAt!.getTime() - clock.now().getTime()) / 1_000)));
  return { state: "retry", delaySeconds };
}
