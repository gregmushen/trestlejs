import { createTenantDatabase, webhookEndpoint } from "@__TRESTLE_PROJECT_NAME__/db";
import { defineEvent, defineEventCatalog } from "@__TRESTLE_PROJECT_NAME__/events";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createEventPublisher } from "./events.js";

const databaseUrl = process.env.TRESTLE_SYSTEM_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const admin = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false }) : undefined;
const tenantId = `event-atomic-${crypto.randomUUID().slice(0, 8)}`;
const payload = z.object({ endpointId: z.uuid() });
const catalog = defineEventCatalog([defineEvent({
  name: "endpoint.created", schemaVersion: 1, description: "An endpoint was created",
  sensitivity: "internal", payload,
  resource: { type: "endpoint", id: (value: z.infer<typeof payload>) => value.endpointId },
})]);

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
});
