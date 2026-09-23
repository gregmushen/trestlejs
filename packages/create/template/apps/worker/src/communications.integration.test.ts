import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userId: "", organizationId: "" }));

vi.mock("@__TRESTLE_PROJECT_NAME__/auth", () => ({
  loadAuthPolicy: vi.fn(async () => ({ policy: {}, version: null, loadedAt: 0 })),
  createAuth: () => ({
    handler: vi.fn(),
    api: { getSession: vi.fn(async () => state.userId ? { user: { id: state.userId, email: `${state.userId}@example.test`, name: state.userId }, session: { id: "s", userId: state.userId, activeOrganizationId: state.organizationId } } : null) },
  }),
}));

import { NativeWebhookTransport, verifySignature, WebhookDispatcher, secretCipher } from "@__TRESTLE_PROJECT_NAME__/domain";
import type { EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";

import { communicationDependencies, notificationService, systemContext, webhookKeyMaterial } from "./communications.js";
import { app } from "./index.js";
import { publishEvent } from "./outbox-runner.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `cm${Date.now()}`;
const org = `${run}-org`;
const owner = `${run}-owner`;
const member = `${run}-member`;
const environment = { DATABASE_URL: connectionString ?? "", DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" as const };

type Sent = { url: string; headers: Record<string, string>; body: string };
const sent: Sent[] = [];
let responseStatus = 200;
const emails: Array<{ to: string; title: string }> = [];

let step = 0;
async function call(method: string, path: string, body?: unknown) {
  const correlation = `${run}-${++step}`;
  const response = await app.request(path, { method, headers: { "content-type": "application/json", "x-correlation-id": correlation }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, environment);
  return { status: response.status, correlation, body: (response.status === 204 ? {} : await response.json()) as Record<string, any> };
}

/** Publishes the outbox events one request produced, as the cron runner would. */
async function publish(correlation: string) {
  const rows = await sql!`select * from outbox_message where correlation_id = ${correlation}`;
  for (const row of rows) {
    const envelope: EventEnvelope = { id: row.id, name: row.event_name, schemaVersion: row.schema_version, occurredAt: new Date(row.occurred_at).toISOString(), resource: { type: row.resource_type, id: row.resource_id }, correlationId: row.correlation_id, idempotencyKey: row.idempotency_key, payload: row.payload };
    await publishEvent(envelope, environment);
  }
  return rows.length;
}

async function dispatcher() {
  return new WebhookDispatcher(communicationDependencies.webhookRepository(environment, org), await secretCipher(webhookKeyMaterial(environment)), new NativeWebhookTransport((url, init) => communicationDependencies.fetcher(url, init)));
}

suite("webhooks and notifications", () => {
  beforeAll(async () => {
    communicationDependencies.fetcher = async (url, init) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return { status: responseStatus };
    };
    communicationDependencies.emailSender = () => async (message) => { emails.push({ to: message.to, title: message.title }); return { id: `email-${emails.length}` }; };
    for (const id of [owner, member]) await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, ${id}, ${`${id}@example.test`}, true, now(), now())`;
    await sql!`insert into organization (id, name, slug, created_at) values (${org}, 'Acme', ${org}, now())`;
    await sql!`insert into organization_subscription (organization_id, provider, plan, plan_version, status) values (${org}, 'local', 'business', 'business@1', 'active')`;
    await sql!`insert into organization_entitlement (organization_id, entitlement, values, inherited_from) values (${org}, 'api.access', '{"maxKeys": 5}'::jsonb, 'business@1')`;
    await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${org}-o`}, ${org}, ${owner}, 'owner', now()), (${`${org}-m`}, ${org}, ${member}, 'member', now())`;
    await sql!`insert into application_role_assignment (organization_id, user_id, role, granted_by) values (${org}, ${owner}, 'app_admin', 'bootstrap')`;
  });

  beforeEach(() => { state.userId = owner; state.organizationId = org; responseStatus = 200; });

  afterAll(async () => {
    for (const table of ["notification_preference", "notification", "webhook_endpoint", "api_key_usage", "api_key", "service_account", "application_role_assignment", "organization_entitlement", "organization_subscription", "audit_event"]) await sql!.unsafe(`delete from ${table} where organization_id = $1`, [org]);
    await sql!`delete from outbox_message where correlation_id like ${`${run}%`}`;
    await sql!`delete from member where organization_id = ${org}`;
    await sql!`delete from organization where id = ${org}`;
    await sql!`delete from "user" where id like ${`${run}%`}`;
    await sql!.end();
  });

  let endpointId = "";
  let secret = "";

  it("creates endpoints for registered events only and reveals the secret once", async () => {
    expect(await call("POST", "/api/tenant/webhooks", { name: "CRM", url: "http://crm.example.com/hook", events: ["api_key.created"] })).toMatchObject({ status: 422, body: { message: /HTTPS/u } });
    expect(await call("POST", "/api/tenant/webhooks", { name: "CRM", url: "https://crm.example.com/hook", events: ["internal.thing"] })).toMatchObject({ status: 422, body: { message: /Unknown webhook events/u } });
    const created = await call("POST", "/api/tenant/webhooks", { name: "CRM", url: "https://crm.example.com/hook?token=abc", events: ["api_key.created", "service_account.created"] });
    expect(created).toMatchObject({ status: 201, body: { endpoint: { urlDisplay: "https://crm.example.com/hook?…", state: "active", health: "untested" } } });
    endpointId = created.body.endpoint.id;
    secret = created.body.secret;
    expect(secret).toMatch(/^whsec_/u);
    const list = await call("GET", "/api/tenant/webhooks");
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(list.body.eventTypes.map((type: { name: string }) => type.name)).toContain("api_key.created");
    state.userId = member;
    expect((await call("GET", "/api/tenant/webhooks")).status).toBe(403);
  });

  it("verifies an endpoint with a signed, marked test event", async () => {
    const tested = await call("POST", `/api/tenant/webhooks/${endpointId}/test`);
    expect(tested).toMatchObject({ status: 200, body: { delivery: { status: "succeeded", test: true, attempts: 1, responseCode: 200 } } });
    const request = sent.at(-1)!;
    expect(JSON.parse(request.body)).toMatchObject({ type: "webhook.test", test: true, organizationId: org });
    expect(await verifySignature(secret, request.headers["webhook-id"]!, Number(request.headers["webhook-timestamp"]), request.body, request.headers["webhook-signature"]!)).toBe(true);
    expect((await call("GET", "/api/tenant/webhooks")).body.endpoints[0]).toMatchObject({ health: "healthy", verifiedAt: expect.any(String) });
  });

  it("publishes committed events to subscribed endpoints and member notifications", async () => {
    const account = await call("POST", "/api/tenant/service-accounts", { name: "sync", applicationRoles: ["reader"] });
    expect(account.status).toBe(201);
    await publish(account.correlation);
    const minted = await call("POST", `/api/tenant/service-accounts/${account.body.serviceAccount.id}/keys`, { scopes: ["resource.read"] });
    expect(minted.status).toBe(201);
    expect(await publish(minted.correlation)).toBe(1);
    const deliveries = await sql!`select id, event_name, payload from webhook_delivery where endpoint_id = ${endpointId} and test = false order by created_at`;
    expect(deliveries.map((row) => row.event_name)).toEqual(["service_account.created", "api_key.created"]);
    // Only the public projection is delivered: no token, verifier, or support metadata.
    expect(deliveries[1]!.payload).toMatchObject({ type: "api_key.created", version: 1, test: false, data: { apiKeyId: minted.body.key.id, scopes: ["resource.read"] } });
    expect(JSON.stringify(deliveries[1]!.payload)).not.toContain(minted.body.token);
    // Idempotent: publishing the same event again adds nothing.
    await publish(minted.correlation);
    expect((await sql!`select 1 from webhook_delivery where endpoint_id = ${endpointId} and event_name = 'api_key.created'`).length).toBe(1);
    // The owner is notified; the plain member is not a recipient of this type.
    const inbox = await call("GET", "/api/tenant/notifications");
    expect(inbox.body).toMatchObject({ unread: 1, notifications: [{ type: "security.api_key_created", title: "API key created" }] });
    state.userId = member;
    expect((await call("GET", "/api/tenant/notifications")).body).toMatchObject({ unread: 0 });
  });

  it("retries failures with backoff, marks the endpoint failing, and replays", async () => {
    responseStatus = 500;
    const [delivery] = await sql!`select id from webhook_delivery where endpoint_id = ${endpointId} and event_name = 'api_key.created'`;
    const context = systemContext(environment, org, "retry-test");
    expect(await (await dispatcher()).attempt(delivery!.id, context)).toBe("pending");
    const [pending] = await sql!`select status, attempts, failure_category, next_attempt_at from webhook_delivery where id = ${delivery!.id}`;
    expect(pending).toMatchObject({ status: "pending", attempts: 1, failure_category: "endpoint_error" });
    expect(new Date(pending!.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(20_000);
    for (let attempt = 2; attempt <= 6; attempt += 1) await (await dispatcher()).attempt(delivery!.id, { ...context, now: new Date() });
    expect((await sql!`select status, attempts from webhook_delivery where id = ${delivery!.id}`)[0]).toMatchObject({ status: "failed", attempts: 6 });
    expect((await call("GET", "/api/tenant/webhooks")).body.endpoints[0]).toMatchObject({ health: "failing" });
    const [failing] = await sql!`select actor_type from audit_event where organization_id = ${org} and name = 'webhooks.endpoint.failing'`;
    expect(failing).toMatchObject({ actor_type: "system" });
    const replay = await call("POST", `/api/tenant/webhook-deliveries/${delivery!.id}/replay`);
    expect(replay.status).toBe(201);
    responseStatus = 204;
    expect(await (await dispatcher()).attempt(replay.body.deliveryId, systemContext(environment, org, "replay"))).toBe("succeeded");
    expect((await call("GET", `/api/tenant/webhook-deliveries/${delivery!.id}`)).body.attempts).toHaveLength(6);
  });

  it("signs with both secrets during a rotation overlap", async () => {
    const rotated = await call("POST", `/api/tenant/webhooks/${endpointId}/rotate-secret`, { overlapHours: 24 });
    expect(rotated.status).toBe(201);
    await call("POST", `/api/tenant/webhooks/${endpointId}/test`);
    const request = sent.at(-1)!;
    const verify = (key: string) => verifySignature(key, request.headers["webhook-id"]!, Number(request.headers["webhook-timestamp"]), request.body, request.headers["webhook-signature"]!);
    expect(await verify(rotated.body.secret)).toBe(true);
    expect(await verify(secret)).toBe(true);
    expect(request.headers["webhook-signature"]!.split(" ")).toHaveLength(2);
  });

  it("pauses without dropping events and cancels them on disable", async () => {
    expect((await call("POST", `/api/tenant/webhooks/${endpointId}/pause`)).status).toBe(204);
    expect((await call("POST", `/api/tenant/webhooks/${endpointId}/test`)).status).toBe(409);
    expect((await call("POST", `/api/tenant/webhooks/${endpointId}/disable`, {})).status).toBe(422);
    expect((await call("POST", `/api/tenant/webhooks/${endpointId}/disable`, { reason: "vendor migration" })).status).toBe(204);
    const [audit] = await sql!`select reason from audit_event where organization_id = ${org} and name = 'webhooks.endpoint.disabled'`;
    expect(audit).toMatchObject({ reason: "vendor migration" });
    expect((await call("POST", `/api/tenant/webhooks/${endpointId}/resume`)).status).toBe(204);
  });

  it("applies preferences: mandatory channels, choices, defaults, email, and grouping", async () => {
    expect(await call("PUT", "/api/tenant/notification-preferences", { type: "webhooks.endpoint_failing", channel: "in_app", enabled: false })).toMatchObject({ status: 409 });
    expect((await call("PUT", "/api/tenant/notification-defaults", { type: "security.api_key_created", channel: "email", enabled: true })).status).toBe(204);
    const preferences = await call("GET", "/api/tenant/notification-preferences");
    const type = preferences.body.types.find((entry: { type: string }) => entry.type === "security.api_key_created");
    expect(type.channels.find((channel: { channel: string }) => channel.channel === "email")).toMatchObject({ enabled: true, source: "organization" });
    state.userId = member;
    expect((await call("PUT", "/api/tenant/notification-defaults", { type: "security.api_key_created", channel: "email", enabled: false })).status).toBe(403);
    state.userId = owner;
    const accounts = await call("GET", "/api/tenant/service-accounts");
    const minted = await call("POST", `/api/tenant/service-accounts/${accounts.body.serviceAccounts[0].id}/keys`, { scopes: ["resource.read"] });
    await publish(minted.correlation);
    // Grouped into the unread notification; no second email for a grouped notification.
    const inbox = await call("GET", "/api/tenant/notifications");
    expect(inbox.body.notifications[0]).toMatchObject({ title: "2 API keys created", count: 2 });
    await call("POST", "/api/tenant/notifications/read", { ids: "all" });
    const third = await call("POST", `/api/tenant/service-accounts/${accounts.body.serviceAccounts[0].id}/keys`, { scopes: ["resource.read"] });
    await publish(third.correlation);
    const [email] = await sql!`select id from notification_delivery where organization_id = ${org} and channel = 'email' and status = 'pending'`;
    expect(await (await notificationService(environment, org)).deliverEmail(email!.id, communicationDependencies.emailSender(environment), systemContext(environment, org, "email"))).toBe("sent");
    expect(emails.at(-1)).toMatchObject({ to: `${owner}@example.test`, title: "API key created" });
    const history = await call("GET", "/api/tenant/notification-deliveries");
    expect(history.body.deliveries.some((row: { channel: string; status: string; preference: string }) => row.channel === "email" && row.status === "sent" && row.preference === "organization")).toBe(true);
    expect(JSON.stringify(history.body)).not.toContain("API key created");
  });

  it("sends published streams by type, records the version, and refuses archived streams", async () => {
    const type = `app.${run.toLowerCase()}_ready`;
    const definition = { inputs: [{ name: "invoiceId", type: "string", required: true }], recipients: ["user"], routes: { in_app: { default: true } }, strategy: "parallel", policy: "user", templates: { title: "Invoice {{invoiceId}}", body: "Ready" } };
    await sql!`insert into notification_stream (type, name, created_by) values (${type}, 'Invoice ready', 'test')`;
    await sql!`insert into notification_stream_version (type, version, state, definition, created_by) values (${type}, 1, 'superseded', ${sql!.json(definition)}, 'test'), (${type}, 2, 'active', ${sql!.json(definition)}, 'test')`;
    try {
      const context = systemContext(environment, org, "stream-test");
      await expect((await notificationService(environment, org)).send(context, { type, recipient: { userId: member }, data: { invoiceId: "in_1" } })).resolves.toEqual({ created: 1, streamVersion: 2 });
      const [row] = await sql!`select title, stream_version from notification where organization_id = ${org} and type = ${type}`;
      expect(row).toMatchObject({ title: "Invoice in_1", stream_version: 2 });
      await expect((await notificationService(environment, org)).send(context, { type, recipient: { userId: `${run}-stranger` }, data: { invoiceId: "in_1" } })).rejects.toThrow(/members of this organization/u);
      await sql!`update notification_stream set archived_at = now(), archived_by = 'test' where type = ${type}`;
      await expect((await notificationService(environment, org)).send(context, { type, recipient: { userId: member }, data: { invoiceId: "in_2" } })).rejects.toThrow(/archived/u);
    } finally {
      await sql!`delete from notification where organization_id = ${org} and type = ${type}`;
      await sql!`delete from notification_stream_version where type = ${type}`;
      await sql!`delete from notification_stream where type = ${type}`;
    }
  });
});
