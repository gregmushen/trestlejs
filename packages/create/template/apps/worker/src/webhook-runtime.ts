import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { PostgresBillingProjectionRepository } from "@__TRESTLE_PROJECT_NAME__/billing";
import { createLogger } from "@__TRESTLE_PROJECT_NAME__/context";
import { createTenantDatabase, projectCommittedWebhook, type Database, type WebhookProjectionResult } from "@__TRESTLE_PROJECT_NAME__/db";
import { applicationEventCatalog, type EventEnvelope, type OutboxEntry, type defineEventCatalog } from "@__TRESTLE_PROJECT_NAME__/events";

type Catalog = ReturnType<typeof defineEventCatalog>;
type CommittedStore = { findCommitted(id: string): Promise<OutboxEntry | null> };

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item);
}

/** Queue and Workflow envelopes carry an ID, not tenant authority. Reload and
 * verify the committed row before a tenant-scoped projection is attempted. */
export async function projectWebhookForEvent(input: {
  envelope: EventEnvelope;
  environment: AuthEnvironment;
  outbox: CommittedStore;
  catalog?: Catalog;
  tenantDatabase?: (organizationId: string) => Database;
  hasEntitlement?: (organizationId: string, entitlement: string) => Promise<boolean>;
  now?: () => Date;
}): Promise<WebhookProjectionResult | null> {
  const catalog = input.catalog ?? applicationEventCatalog;
  const queued = input.envelope;
  const mode = input.environment.WEBHOOK_DELIVERY_MODE ?? "disabled";
  if (mode === "disabled") return null;
  if (mode !== "local") throw new Error(`Outbound webhook mode ${mode} is not implemented`);
  if (input.environment.APP_ENV && input.environment.APP_ENV !== "local") throw new Error("Local outbound webhook mode requires a local environment");
  if (!catalog.has(queued.name, queued.schemaVersion)) return null;
  const committed = await input.outbox.findCommitted(queued.id);
  if (!committed) throw new Error("Committed event was not found");
  const actual = committed.message;
  if (actual.id !== queued.id || actual.name !== queued.name || actual.schemaVersion !== queued.schemaVersion
    || actual.idempotencyKey !== queued.idempotencyKey || actual.correlationId !== queued.correlationId
    || actual.resource.type !== queued.resource.type || actual.resource.id !== queued.resource.id
    || canonicalJson(actual.payload) !== canonicalJson(queued.payload)) {
    throw new Error("Queue event differs from its committed outbox row");
  }
  const billing = new PostgresBillingProjectionRepository(input.environment.DATABASE_URL, input.environment.DATABASE_DRIVER);
  const result = await projectCommittedWebhook({
    eventId: actual.id,
    environment: input.environment.APP_ENV ?? "local",
    catalog,
    outbox: { findCommitted: async (id) => id === actual.id ? committed : null },
    tenantDatabase: input.tenantDatabase ?? ((organizationId) => createTenantDatabase(input.environment.DATABASE_URL, input.environment.DATABASE_DRIVER, organizationId)),
    hasEntitlement: input.hasEntitlement ?? (async (organizationId, entitlement) => {
      const subscription = await billing.get(organizationId);
      return subscription?.entitlements.includes(entitlement) ?? false;
    }),
    ...(input.now ? { now: input.now } : {}),
  });
  createLogger({ correlationId: actual.correlationId, organizationId: committed.organizationId }).info(
    result.state === "private" ? "webhook.projection.private" : result.state === "suppressed" ? "webhook.projection.suppressed" : "webhook.projection.ready",
    { eventId: actual.id, ...(result.state === "private" ? {} : { webhookMessageId: result.messageId, deliveries: result.deliveries, created: result.created }) },
  );
  return result;
}
