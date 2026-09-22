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

import { app } from "./index.js";

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

  it("reports health", async () => {
    const response = await app.request("/api/health", undefined, environment);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("rejects an anonymous protected request", async () => {
    const response = await app.request("/api/me", undefined, environment);
    expect(response.status).toBe(401);
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
