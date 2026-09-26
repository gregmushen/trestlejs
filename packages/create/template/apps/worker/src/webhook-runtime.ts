import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { PostgresBillingProjectionRepository } from "@__TRESTLE_PROJECT_NAME__/billing";
import { createLogger, loggerSecretsFromEnvironment } from "@__TRESTLE_PROJECT_NAME__/context";
import { captureLocalWebhookDelivery, createTenantDatabase, loadCurrentWebhookSigningSecret, projectCommittedWebhook, verifyCommittedEvent, webhookDelivery, webhookEndpoint, type CommittedEventStore, type Database, type LocalWebhookScenario, type NativeWebhookWakeup, type WebhookProjectionResult } from "@__TRESTLE_PROJECT_NAME__/db";
import { applicationEventCatalog, type CloudflareQueueBinding, type EventEnvelope, type OutboxEntry, type defineEventCatalog } from "@__TRESTLE_PROJECT_NAME__/events";
import { and, eq, isNull } from "drizzle-orm";

import { frameworkDueWork, scheduleDueWork, type DueWorkSchedulerBinding } from "./scheduler.js";

type Catalog = ReturnType<typeof defineEventCatalog>;

/** The tenant's current entitlement from the billing projection, read at handling time. */
export async function hasCurrentEntitlement(environment: AuthEnvironment, organizationId: string, entitlement: string,
  billing = new PostgresBillingProjectionRepository(environment.DATABASE_URL, environment.DATABASE_DRIVER)): Promise<boolean> {
  const subscription = await billing.get(organizationId);
  return subscription?.entitlements.includes(entitlement) ?? false;
}

/** Queue and Workflow envelopes carry an ID, not tenant authority. Reload and
 * verify the committed row before a tenant-scoped projection is attempted.
 * A caller that already verified the envelope may pass `committed` to skip the
 * second query; it is still compared against the envelope. */
export async function projectWebhookForEvent(input: {
  envelope: EventEnvelope;
  environment: AuthEnvironment;
  outbox: CommittedEventStore;
  committed?: OutboxEntry;
  catalog?: Catalog;
  tenantDatabase?: (organizationId: string) => Database;
  hasEntitlement?: (organizationId: string, entitlement: string) => Promise<boolean>;
  now?: () => Date;
  localScenario?: LocalWebhookScenario;
  queue?: CloudflareQueueBinding<NativeWebhookWakeup>;
  /** Records a local delivery's retry time, so the retry runs when due. */
  scheduler?: DueWorkSchedulerBinding;
}): Promise<WebhookProjectionResult | null> {
  const catalog = input.catalog ?? applicationEventCatalog;
  const queued = input.envelope;
  const mode = input.environment.WEBHOOK_DELIVERY_MODE ?? "disabled";
  if (mode === "disabled") return null;
  if (mode === "svix") throw new Error("Outbound webhook mode svix is not implemented");
  if (mode === "local" && input.environment.APP_ENV && input.environment.APP_ENV !== "local") throw new Error("Local outbound webhook mode requires a local environment");
  if (mode === "native" && (!input.environment.APP_ENV || input.environment.APP_ENV === "local" || !input.queue || !input.environment.WEBHOOK_SECRET_KEY)) throw new Error("Native outbound webhooks require a remote environment, Queue binding, and signing key");
  if (!catalog.has(queued.name, queued.schemaVersion)) return null;
  const verified = input.committed;
  const store: CommittedEventStore = verified ? { findCommitted: async (id) => id === verified.id ? verified : null } : input.outbox;
  const committed = await verifyCommittedEvent(store, queued, input.now ? { now: input.now() } : {});
  const actual = committed.message;
  const tenantDatabase = input.tenantDatabase ?? ((organizationId: string) => createTenantDatabase(input.environment.DATABASE_URL, input.environment.DATABASE_DRIVER, organizationId));
  const billing = new PostgresBillingProjectionRepository(input.environment.DATABASE_URL, input.environment.DATABASE_DRIVER);
  const result = await projectCommittedWebhook({
    eventId: actual.id,
    environment: input.environment.APP_ENV ?? "local",
    catalog,
    outbox: { findCommitted: async (id) => id === actual.id ? committed : null },
    tenantDatabase,
    hasEntitlement: input.hasEntitlement ?? (async (organizationId, entitlement) => await hasCurrentEntitlement(input.environment, organizationId, entitlement, billing)),
    ...(input.now ? { now: input.now } : {}),
  });
  if (result.state === "ready" && result.deliveries > 0) {
    if (!committed.organizationId) throw new Error("Public webhook event has no committed organization");
    const organizationId = committed.organizationId;
    const deliveries = await tenantDatabase(organizationId).select({
      id: webhookDelivery.id, endpointId: webhookDelivery.endpointId,
    }).from(webhookDelivery)
      .innerJoin(webhookEndpoint, and(eq(webhookEndpoint.id, webhookDelivery.endpointId), eq(webhookEndpoint.organizationId, webhookDelivery.organizationId)))
      .where(and(
      eq(webhookDelivery.organizationId, organizationId), eq(webhookDelivery.messageId, result.messageId),
      eq(webhookEndpoint.provider, mode), eq(webhookEndpoint.environment, input.environment.APP_ENV ?? "local"),
      eq(webhookEndpoint.state, "active"), isNull(webhookEndpoint.deletedAt),
    ));
    for (const delivery of deliveries) {
      if (mode === "native") {
        await input.queue!.send({ sourceEventId: actual.id, deliveryId: delivery.id }, { contentType: "json" });
        continue;
      }
      const masterKey = input.environment.WEBHOOK_SECRET_KEY;
      if (!masterKey) throw new Error("Local outbound webhook signing key is not configured");
      const signingSecret = await loadCurrentWebhookSigningSecret({
        tenantDatabase, masterKey, environment: "local", organizationId,
        endpointId: delivery.endpointId,
      });
      if (!signingSecret) throw new Error("Local outbound webhook endpoint has no current signing secret");
      const captured = await captureLocalWebhookDelivery({
        organizationId, deliveryId: delivery.id, tenantDatabase, signingSecret,
        scenario: input.localScenario ?? { kind: "succeed" }, clock: { now: input.now ?? (() => new Date()) },
      });
      if (captured.state === "retry" && captured.nextRetryAt) {
        // The retry is durable in webhook_delivery; recording it only makes it run on time.
        try { await scheduleDueWork(input.scheduler, [{ key: frameworkDueWork.webhooks(organizationId), dueAt: captured.nextRetryAt }]); }
        catch { createLogger({ organizationId }, undefined, { secretValues: loggerSecretsFromEnvironment(input.environment) }).warn("webhook.local.retry.unscheduled", { deliveryId: delivery.id }); }
      }
    }
  }
  createLogger({ correlationId: actual.correlationId, organizationId: committed.organizationId }, undefined, { secretValues: loggerSecretsFromEnvironment(input.environment) }).info(
    result.state === "private" ? "webhook.projection.private" : result.state === "suppressed" ? "webhook.projection.suppressed" : "webhook.projection.ready",
    { eventId: actual.id, ...(result.state === "private" ? {} : { webhookMessageId: result.messageId, deliveries: result.deliveries, created: result.created }) },
  );
  return result;
}
