import { PostgresEventInbox, PostgresOutboxStore } from "@__TRESTLE_PROJECT_NAME__/db";
import { defineEvent, defineEventCatalog, eventEnvelopeSchema } from "@__TRESTLE_PROJECT_NAME__/events";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createQueueConsumer, EventConsumerRegistry } from "./async-runtime.js";
import { projectWebhookForEvent } from "./webhook-runtime.js";

const databaseUrl = process.env.TRESTLE_SYSTEM_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(process.env.TRESTLE_SYSTEM_TEST_MIGRATION_URL ?? databaseUrl, { max: 1, prepare: false }) : undefined;
const outbox = databaseUrl ? new PostgresOutboxStore(databaseUrl, { assumeApplicationRole: true }) : undefined;
const inbox = databaseUrl ? new PostgresEventInbox(databaseUrl, { assumeApplicationRole: true }) : undefined;
const ids: string[] = [];
const endpointIds: string[] = [];
const payload = z.object({ articleId: z.string(), title: z.string() });
const catalog = defineEventCatalog([defineEvent({
  name: "article.published", schemaVersion: 1, description: "Article published", sensitivity: "internal",
  resource: { type: "article", id: (value: z.infer<typeof payload>) => value.articleId }, payload,
  webhook: { type: "article.published", version: 1, description: "Article published for customers", payload,
    project: (value) => value, sensitivity: { classification: "customer", retentionClass: "standard" },
    examples: [{ articleId: "example", title: "Example" }],
    fixtures: [{ internal: { articleId: "example", title: "Example" }, public: { articleId: "example", title: "Example" } }],
  },
})]);

suite("Queue to committed outbound webhook projection", () => {
  afterAll(async () => {
    if (ids.length) await sql!`delete from webhook_delivery where message_id in (select id from webhook_message where source_event_id = any(${ids}))`;
    if (ids.length) await sql!`delete from webhook_message where source_event_id = any(${ids})`;
    if (endpointIds.length) await sql!`delete from webhook_endpoint where id = any(${endpointIds})`;
    if (ids.length) await sql!`delete from event_inbox where idempotency_key = any(${ids})`;
    if (ids.length) await sql!`delete from outbox_message where id = any(${ids})`;
    await Promise.all([outbox!.close(), inbox!.close(), sql!.end()]);
  });

  it("projects a subscribed committed event once, then acknowledges duplicates", async () => {
    const organizationId = `webhook-runtime-${crypto.randomUUID()}`;
    const [endpoint] = await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by) values (${organizationId}, 'local', 'Runtime test', 'https://example.test/hook', 'active', 'local', 'test-user', 'test-user') returning id`;
    endpointIds.push(endpoint!.id);
    await sql!`insert into webhook_subscription (organization_id, endpoint_id, public_event_type, public_version, created_by) values (${organizationId}, ${endpoint!.id}, 'article.published', 1, 'test-user')`;
    const id = crypto.randomUUID();
    ids.push(id);
    const event = eventEnvelopeSchema.parse({ id, name: "article.published", schemaVersion: 1, occurredAt: new Date().toISOString(), resource: { type: "article", id: "article-1" }, correlationId: id, idempotencyKey: id, payload: { articleId: "article-1", title: "Hello" } });
    await outbox!.append(event, { organizationId });
    const environment = { DATABASE_URL: databaseUrl!, DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-only-secret", APP_ENV: "local" as const, WEBHOOK_DELIVERY_MODE: "local" as const };
    const registry = new EventConsumerRegistry(catalog);
    const consumer = createQueueConsumer(registry, inbox!, async (envelope) => {
      await projectWebhookForEvent({ envelope, environment, outbox: outbox!, catalog });
    });
    expect(await projectWebhookForEvent({ envelope: event, environment: { ...environment, WEBHOOK_DELIVERY_MODE: "disabled" }, outbox: outbox!, catalog })).toBeNull();
    await expect(projectWebhookForEvent({ envelope: event, environment: { ...environment, WEBHOOK_DELIVERY_MODE: "native" }, outbox: outbox!, catalog })).rejects.toThrow("not implemented");
    await expect(projectWebhookForEvent({ envelope: event, environment: { ...environment, APP_ENV: "production" }, outbox: outbox!, catalog })).rejects.toThrow("local environment");
    const states: string[] = [];
    const batch = { messages: [{ body: event, ack: () => states.push("ack"), retry: () => states.push("retry") }] };
    expect(await consumer(batch, environment)).toEqual({ acknowledged: 1, retried: 0 });
    expect(await consumer(batch, environment)).toEqual({ acknowledged: 1, retried: 0 });
    expect(states).toEqual(["ack", "ack"]);
    expect((await sql!`select id from webhook_message where source_event_id=${id}`)).toHaveLength(1);
    expect((await sql!`select id from webhook_delivery where endpoint_id=${endpoint!.id}`)).toHaveLength(1);
    const forged = { ...event, payload: { articleId: "article-1", title: "Forged" } };
    await expect(projectWebhookForEvent({ envelope: forged, environment, outbox: outbox!, catalog })).rejects.toThrow("differs from its committed");
    expect(await consumer({ messages: [{ body: forged, ack: () => states.push("ack"), retry: () => states.push("retry") }] }, environment)).toEqual({ acknowledged: 1, retried: 0 });
  });
});
