import { createTenantDatabase, PostgresEventInbox, PostgresOutboxStore, webhookEndpoint } from "@__TRESTLE_PROJECT_NAME__/db";
import { defineEvent, defineEventCatalog, EVENT_PROVENANCE_RETENTION_DAYS, eventEnvelopeSchema, type QueueSettlement } from "@__TRESTLE_PROJECT_NAME__/events";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createQueueConsumer, EventConsumerRegistry } from "./async-runtime.js";
import { createEventPublisher } from "./events.js";

const databaseUrl = process.env.TRESTLE_SYSTEM_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const admin = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false }) : undefined;
const tenantId = `event-atomic-${crypto.randomUUID().slice(0, 8)}`;
const payload = z.object({ endpointId: z.uuid() });
const endpointCreated = defineEvent({
  name: "endpoint.created", schemaVersion: 1, description: "An endpoint was created",
  sensitivity: "internal", payload,
  resource: { type: "endpoint", id: (value: z.infer<typeof payload>) => value.endpointId },
});
const catalog = defineEventCatalog([endpointCreated]);

suite("tenant-bound transactional event composition", () => {
  afterAll(async () => {
    if (!admin) return;
    await admin`delete from outbox_message where organization_id=${tenantId}`;
    await admin`delete from webhook_endpoint where organization_id=${tenantId}`;
    await admin.end();
  });

  it("commits domain state and the outbox together and deduplicates retries", async () => {
    const id = crypto.randomUUID();
    const database = createTenantDatabase(databaseUrl!, "postgres-js", tenantId);
    const events = createEventPublisher({ organizationId: tenantId, correlationId: "request-1", catalog });
    await database.transaction(async (transaction) => {
      await transaction.insert(webhookEndpoint).values({ id, organizationId: tenantId, environment: "local", name: "Atomic endpoint",
        destinationUrl: "https://example.test/hook", provider: "local", createdBy: "test-user", updatedBy: "test-user" });
      await transaction.execute(events.statement("endpoint.created", { endpointId: id }, { idempotencyKey: `endpoint:${id}` }));
    });
    await database.transaction(async (transaction) => {
      await transaction.execute(events.statement("endpoint.created", { endpointId: id }, { idempotencyKey: `endpoint:${id}` }));
    });
    expect(await admin!`select id from webhook_endpoint where id=${id}`).toHaveLength(1);
    const rows = await admin!`select organization_id, event_name, resource_id, correlation_id, idempotency_key from outbox_message where organization_id=${tenantId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organization_id: tenantId, event_name: "endpoint.created", resource_id: id,
      correlation_id: "request-1", idempotency_key: `${tenantId}:endpoint:${id}` });
  });

  it("rolls both records back when the domain transaction fails", async () => {
    const id = crypto.randomUUID();
    const database = createTenantDatabase(databaseUrl!, "postgres-js", tenantId);
    const events = createEventPublisher({ organizationId: tenantId, correlationId: "request-rollback", catalog });
    await expect(database.transaction(async (transaction) => {
      await transaction.insert(webhookEndpoint).values({ id, organizationId: tenantId, environment: "local", name: "Rolled back",
        destinationUrl: "https://example.test/hook", provider: "local", createdBy: "test-user", updatedBy: "test-user" });
      await transaction.execute(events.statement("endpoint.created", { endpointId: id }, { idempotencyKey: `endpoint:${id}` }));
      throw new Error("domain mutation failed");
    })).rejects.toThrow("domain mutation failed");
    expect(await admin!`select id from webhook_endpoint where id=${id}`).toHaveLength(0);
    expect(await admin!`select id from outbox_message where resource_id=${id}`).toHaveLength(0);
  });

  it("keeps young provenance through a legal prune and rejects a delivery whose row has expired", async () => {
    const outbox = new PostgresOutboxStore(databaseUrl!, { assumeApplicationRole: true });
    const retention = new PostgresOutboxStore(databaseUrl!);
    const inbox = new PostgresEventInbox(databaseUrl!, { assumeApplicationRole: true });
    const id = crypto.randomUUID();
    const event = eventEnvelopeSchema.parse({ id, name: "endpoint.created", schemaVersion: 1, occurredAt: new Date().toISOString(), resource: { type: "endpoint", id }, correlationId: "late-delivery", idempotencyKey: `late:${id}`, payload: { endpointId: id } });
    const handled: string[] = [];
    const settlements: QueueSettlement[] = [];
    const registry = new EventConsumerRegistry(catalog);
    registry.register({ name: endpointCreated.name, schemaVersion: endpointCreated.schemaVersion, parse: (value: unknown) => payload.parse(value) }, async (parsed) => { handled.push(parsed.endpointId); });
    const consumer = createQueueConsumer(registry, inbox, outbox, undefined, (settlement) => settlements.push(settlement));
    const deliver = async () => {
      const states: string[] = [];
      const result = await consumer({ messages: [{ body: event, ack: () => states.push("ack"), retry: () => states.push("retry") }] }, {});
      return { result, states };
    };
    try {
      await outbox.append(event, { organizationId: tenantId });
      await admin!`update outbox_message set status='leased', leased_until=now() + interval '1 minute' where id=${id}`;
      await outbox.succeed(id);
      // The legal cutoff is 30 days old; this succeeded row is minutes old, so it survives.
      await retention.pruneSucceeded(new Date(Date.now() - EVENT_PROVENANCE_RETENTION_DAYS * 86_400_000), 10_000);
      expect(await admin!`select id from outbox_message where id=${id}`).toHaveLength(1);
      expect(await deliver()).toEqual({ result: { acknowledged: 1, retried: 0 }, states: ["ack"] });
      expect(handled).toEqual([id]);
      // Simulate expiry: the committed row is gone, so a replay has nothing to verify against.
      await admin!`delete from outbox_message where id=${id}`;
      expect(await deliver()).toEqual({ result: { acknowledged: 0, retried: 1 }, states: ["retry"] });
      expect(settlements.at(-1)).toMatchObject({ outcome: "retried", reason: "provenance_missing" });
      expect(handled).toEqual([id]);
    } finally {
      await admin!`delete from event_inbox where idempotency_key=${event.idempotencyKey}`;
      await admin!`delete from outbox_message where id=${id}`;
      await Promise.all([outbox.close(), retention.close(), inbox.close()]);
    }
  });
});
