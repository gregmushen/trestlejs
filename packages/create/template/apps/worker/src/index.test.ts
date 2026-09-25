import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ authenticated: false, committed: new Map<string, { id: string; message: unknown; organizationId?: string }>() }));

vi.mock("@__TRESTLE_PROJECT_NAME__/auth", () => ({
  createAuth: () => ({
    handler: vi.fn(),
    api: {
      getSession: vi.fn(async () =>
        state.authenticated
          ? {
              user: { id: "user-1", name: "Test User", email: "test@example.test" },
              session: { id: "session-1", userId: "user-1" },
            }
          : null,
      ),
    },
  }),
}));

// Queue and Workflow delivery reload the committed outbox row; these tests supply it without a database.
vi.mock("@__TRESTLE_PROJECT_NAME__/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@__TRESTLE_PROJECT_NAME__/db")>(),
  PostgresOutboxStore: class {
    async findCommitted(id: string) { return state.committed.get(id) ?? null; }
    async close() {}
  },
}));

import worker, { app } from "./index.js";
import { eventEnvelopeSchema } from "@__TRESTLE_PROJECT_NAME__/events";

const environment = {
  DATABASE_URL: "postgres://unused",
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:42069",
  APP_ENV: "local" as const,
};

describe("worker routes", () => {
  beforeEach(() => {
    state.authenticated = false;
  });

  it("fails remote scheduled dispatch without its Queue binding", async () => {
    await expect(worker.scheduled(undefined, { ...environment, APP_ENV: "preview" })).rejects.toThrow("Queue or R2 binding");
    await expect(worker.scheduled(undefined, environment)).resolves.toBeUndefined();
  });

  it("runs framework maintenance only on the framework tick", async () => {
    // Without bindings, maintenance throws, so resolving proves an application cron skipped it.
    await expect(worker.scheduled({ cron: "0 * * * *" }, { ...environment, APP_ENV: "preview" })).resolves.toBeUndefined();
    await expect(worker.scheduled({ cron: "* * * * *" }, { ...environment, APP_ENV: "preview" })).rejects.toThrow("Queue or R2 binding");
  });

  it("fails enabled Workflow delivery without its binding", async () => {
    await expect(worker.queue({ messages: [] }, { ...environment, APP_ENV: "preview", TRESTLE_WORKFLOWS_ENABLED: "true" })).rejects.toThrow("TRESTLE_WORKFLOW binding");
    const health = await app.request("/api/health/operational", undefined, { ...environment, APP_ENV: "preview", TRESTLE_WORKFLOWS_ENABLED: "true" });
    await expect(health.json()).resolves.toMatchObject({ capabilities: { workflows: { enabled: true, configured: false } } });
  });

  it("logs validated Queue correlation and causation without raw payloads", async () => {
    const rawSecret = "untrusted-queue-payload-secret";
    const event = eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "billing.checkout.completed", schemaVersion: 1,
      occurredAt: new Date().toISOString(), resource: { type: "organization", id: "org-1" }, correlationId: "corr-queue", causationId: "cause-queue",
      idempotencyKey: "checkout:org-1", payload: { organizationId: "org-1", currentSubscription: false, extra: rawSecret } });
    state.committed.set(event.id, { id: event.id, message: event, organizationId: "org-1" });
    const output: string[] = [];
    const states: string[] = [];
    const original = console.log;
    console.log = (...items: unknown[]) => { output.push(items.map(String).join(" ")); };
    try {
      expect(await worker.queue({ messages: [
        { body: event, ack: () => states.push("ack"), retry: () => states.push("unexpected") },
        { body: { payload: rawSecret }, ack: () => states.push("unexpected"), retry: () => states.push("retry") },
      ] }, { ...environment, TRESTLE_WORKFLOWS_ENABLED: "true", TRESTLE_WORKFLOW: { create: async () => ({ id: event.id }), get: async () => null } })).toEqual({ acknowledged: 1, retried: 1 });
    } finally { console.log = original; }
    expect(states).toEqual(["ack", "retry"]);
    const records = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ event: "queue.event.acknowledged", correlationId: "corr-queue", causationId: "cause-queue", eventId: event.id })]));
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ event: "queue.event.retried", validated: false })]));
    expect(output.join("\n")).not.toContain(rawSecret);
  });

  it("logs a permanent event rejection with its reason, retries it, and never logs the payload", async () => {
    const rawSecret = "forged-queue-payload-secret";
    const event = eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "billing.checkout.completed", schemaVersion: 1,
      occurredAt: new Date().toISOString(), resource: { type: "organization", id: "org-1" }, correlationId: "corr-rejected",
      idempotencyKey: "checkout:org-rejected", payload: { organizationId: "org-1", currentSubscription: false, extra: rawSecret } });
    // The committed row differs from the delivered message, so it is rejected before any Workflow instance exists.
    state.committed.set(event.id, { id: event.id, message: { ...event, payload: { organizationId: "org-1", currentSubscription: false } }, organizationId: "org-1" });
    const created: string[] = [];
    const output: string[] = [];
    const states: string[] = [];
    const original = console.log;
    console.log = (...items: unknown[]) => { output.push(items.map(String).join(" ")); };
    try {
      expect(await worker.queue({ messages: [
        { body: event, ack: () => states.push("unexpected"), retry: () => states.push("retry") },
      ] }, { ...environment, TRESTLE_WORKFLOWS_ENABLED: "true", TRESTLE_WORKFLOW: { create: async ({ id }: { id: string }) => { created.push(id); return { id }; }, get: async () => null } })).toEqual({ acknowledged: 0, retried: 1 });
    } finally { console.log = original; }
    expect(states).toEqual(["retry"]);
    expect(created).toEqual([]);
    const records = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([expect.objectContaining({ level: "warn", event: "queue.event.rejected", correlationId: "corr-rejected", eventId: event.id, eventName: event.name, reason: "provenance_mismatch" })]);
    expect(output.join("\n")).not.toContain(rawSecret);
  });

  it("reports health", async () => {
    const response = await app.request("/api/health", undefined, environment);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("redacts a runtime credential embedded in a request path", async () => {
    const secret = "worker-credential-unique-123456";
    const output: string[] = [];
    const original = console.log;
    console.log = (...items: unknown[]) => { output.push(items.map(String).join(" ")); };
    try {
      await app.request(`/api/${secret}`, undefined, { ...environment, BETTER_AUTH_SECRET: secret });
    } finally { console.log = original; }
    expect(output.join("\n")).toContain("[REDACTED]");
    expect(output.join("\n")).not.toContain(secret);
  });

  it("reports provider capability readiness without returning credential values", async () => {
    const response = await app.request("/api/health/operational", undefined, { ...environment, APP_ENV: "staging" as const, EMAIL_DELIVERY_MODE: "resend" as const, RESEND_API_KEY: "re_sensitive", EMAIL_FROM: "sender@example.test", EMAIL_STAGING_REDIRECT: "capture@example.test", STRIPE_MODE: "test" as const, STRIPE_SECRET_KEY: "sk_test_sensitive", STRIPE_WEBHOOK_SECRET: "whsec_sensitive", STRIPE_PUBLISHABLE_KEY: "pk_test_example", STRIPE_PRICES: JSON.stringify({ starter: "price_starter", pro: "price_pro", business: "price_business" }), BILLING_RETURN_URL: "https://example.test/billing" });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"configured":true');
    expect(body).not.toContain("sensitive");
  });

  it("does not report billing ready for a partial price map or local mode in staging", async () => {
    const partial = { ...environment, APP_ENV: "staging" as const, STRIPE_MODE: "test" as const,
      STRIPE_SECRET_KEY: "sk_test_sensitive", STRIPE_WEBHOOK_SECRET: "whsec_sensitive",
      STRIPE_PUBLISHABLE_KEY: "pk_test_example", STRIPE_PRICES: JSON.stringify({ pro: "price_pro" }),
      BILLING_RETURN_URL: "https://example.test/billing" };
    const response = await app.request("/api/health/operational", undefined, partial);
    await expect(response.json()).resolves.toMatchObject({ capabilities: { billing: { configured: false } } });
    const localMode = await app.request("/api/health/operational", undefined, { ...partial, STRIPE_MODE: "local" as const });
    await expect(localMode.json()).resolves.toMatchObject({ capabilities: { billing: { configured: false } } });
  });

  it("accepts a restricted test-mode Stripe server key without accepting a live one", async () => {
    const base = { ...environment, APP_ENV: "staging" as const, STRIPE_MODE: "test" as const,
      STRIPE_SECRET_KEY: "rk_test_sensitive", STRIPE_WEBHOOK_SECRET: "whsec_sensitive",
      STRIPE_PUBLISHABLE_KEY: "pk_test_example", STRIPE_PRICES: JSON.stringify({ starter: "price_starter", pro: "price_pro", business: "price_business" }),
      BILLING_RETURN_URL: "https://example.test/billing" };
    const accepted = await app.request("/api/health/operational", undefined, base);
    await expect(accepted.json()).resolves.toMatchObject({ capabilities: { billing: { configured: true } } });
    const rejected = await app.request("/api/health/operational", undefined, { ...base, STRIPE_SECRET_KEY: "rk_live_sensitive" });
    await expect(rejected.json()).resolves.toMatchObject({ capabilities: { billing: { configured: false } } });
  });

  it("reports the deployed Queue binding independently of Workflow readiness", async () => {
    const response = await app.request("/api/health/operational", undefined, {
      ...environment,
      APP_ENV: "preview" as const,
      TRESTLE_EVENTS: { send: async () => undefined },
      TRESTLE_WORKFLOWS_ENABLED: "true",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ capabilities: {
      queues: { configured: true },
      workflows: { enabled: true, configured: false },
    } });
  });

  it("does not mistake generated placeholders for configured preview providers", async () => {
    const response = await app.request("/api/health/operational", undefined, { ...environment, APP_ENV: "preview" as const, EMAIL_DELIVERY_MODE: "resend" as const, RESEND_API_KEY: "re_sensitive", EMAIL_FROM: "CHANGE_ME", EMAIL_STAGING_REDIRECT: "CHANGE_ME", STRIPE_MODE: "test" as const, STRIPE_SECRET_KEY: "sk_test_sensitive", STRIPE_WEBHOOK_SECRET: "whsec_sensitive", STRIPE_PUBLISHABLE_KEY: "CHANGE_ME", STRIPE_PRICES: "{}", BILLING_RETURN_URL: "CHANGE_ME" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ capabilities: { email: { configured: false, stagingProtected: false }, billing: { configured: false } } });
  });

  it("rejects an anonymous protected request", async () => {
    const response = await app.request("/api/me", undefined, environment);
    expect(response.status).toBe(401);
  });

  it("rejects anonymous webhook inspection before querying tenant data", async () => {
    const endpoint = await app.request("/api/developer/webhooks/endpoints", undefined, environment);
    const events = await app.request("/api/developer/webhooks/events", undefined, environment);
    const create = await app.request("/api/developer/webhooks/endpoints", { method: "POST", headers: { origin: "http://localhost:42069", "content-type": "application/json" }, body: "{}" }, environment);
    const stateChange = await app.request(`/api/developer/webhooks/endpoints/${crypto.randomUUID()}/state`, { method: "PATCH", headers: { origin: "http://localhost:42069", "content-type": "application/json" }, body: '{"state":"active"}' }, environment);
    const subscriptions = await app.request(`/api/developer/webhooks/endpoints/${crypto.randomUUID()}/subscriptions`, undefined, environment);
    const replace = await app.request(`/api/developer/webhooks/endpoints/${crypto.randomUUID()}/subscriptions`, { method: "PATCH", headers: { origin: "http://localhost:42069", "content-type": "application/json" }, body: '{"subscriptions":[]}' }, environment);
    const deliveries = await app.request(`/api/developer/webhooks/endpoints/${crypto.randomUUID()}/deliveries`, undefined, environment);
    const attempts = await app.request(`/api/developer/webhooks/deliveries/whd_${"a".repeat(64)}/attempts`, undefined, environment);
    const replay = await app.request(`/api/developer/webhooks/deliveries/whd_${"a".repeat(64)}/replay`, { method: "POST", headers: { origin: "http://localhost:42069" } }, environment);
    expect([endpoint.status, events.status, create.status, stateChange.status, subscriptions.status, replace.status, deliveries.status, attempts.status, replay.status]).toEqual([401, 401, 401, 401, 401, 401, 401, 401, 401]);
  });

  it("rejects anonymous artifact uploads and invalid signed access", async () => {
    const upload = await app.request("/api/artifacts", { method: "POST", body: "private" }, environment);
    expect(upload.status).toBe(401);
    const download = await app.request(`/artifacts/${crypto.randomUUID()}?organization=org-a&expires=9999999999999&signature=invalid`, undefined, environment);
    expect(download.status).toBe(404);
  });

  it("returns the authenticated principal", async () => {
    state.authenticated = true;
    const response = await app.request("/api/me", undefined, environment);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: { name: "Test User", email: "test@example.test" },
    });
  });

  it("keeps local email capture available only as an explicit development surface", async () => {
    const response = await app.request("/api/dev/emails", undefined, { ...environment, EMAIL_DELIVERY_MODE: "local" as const });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toHaveProperty("emails");
    const preview = await app.request("/api/dev/emails", undefined, { ...environment, APP_ENV: "preview" as const, EMAIL_DELIVERY_MODE: "local" as const });
    expect(preview.status).toBe(404);
  });

  it("rejects an unsigned provider webhook before reading provider data", async () => {
    const response = await app.request("/api/webhooks/resend", { method: "POST", body: "{}" }, { ...environment, RESEND_API_KEY: "re_test", RESEND_WEBHOOK_SECRET: "whsec_test" });
    expect(response.status).toBe(400);
  });

  it("rejects an unsigned Stripe webhook", async () => {
    const response = await app.request("/webhooks/stripe", { method: "POST", body: "{}" }, { ...environment, STRIPE_WEBHOOK_SECRET: "whsec_test" });
    expect(response.status).toBe(400);
  });
});
