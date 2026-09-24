import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ authenticated: false }));

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

import worker, { app } from "./index.js";

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

  it("fails enabled Workflow delivery without its binding", async () => {
    await expect(worker.queue({ messages: [] }, { ...environment, APP_ENV: "preview", TRESTLE_WORKFLOWS_ENABLED: "true" })).rejects.toThrow("TRESTLE_WORKFLOW binding");
    const health = await app.request("/api/health/operational", undefined, { ...environment, APP_ENV: "preview", TRESTLE_WORKFLOWS_ENABLED: "true" });
    await expect(health.json()).resolves.toMatchObject({ capabilities: { workflows: { enabled: true, configured: false } } });
  });

  it("reports health", async () => {
    const response = await app.request("/api/health", undefined, environment);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
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
