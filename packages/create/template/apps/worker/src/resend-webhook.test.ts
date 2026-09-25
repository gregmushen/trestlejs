import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), returning: vi.fn() }));

vi.mock("@__TRESTLE_PROJECT_NAME__/integrations", async (importOriginal) => ({
  ...await importOriginal<object>(),
  verifyResendWebhook: mocks.verify,
}));

vi.mock("@__TRESTLE_PROJECT_NAME__/db", async (importOriginal) => ({
  ...await importOriginal<object>(),
  createDatabase: () => ({
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: mocks.returning }),
      }),
    }),
  }),
}));

import { app } from "./index.js";

const environment = {
  DATABASE_URL: "postgres://unused",
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:42069",
  APP_ENV: "staging" as const,
  RESEND_API_KEY: "re_test",
  RESEND_WEBHOOK_SECRET: "whsec_test",
};

const event = {
  id: "msg_1",
  emailDeliveryId: "email_1",
  occurredAt: new Date("2026-09-23T00:00:00.000Z"),
  status: "delivered" as const,
};

async function postWebhook() {
  return app.request("/api/webhooks/resend", {
    method: "POST",
    headers: { "svix-id": "msg_1", "svix-timestamp": "1790121600", "svix-signature": "v1,test" },
    body: '{"type":"email.delivered"}',
  }, environment);
}

describe("Resend delivery webhook", () => {
  beforeEach(() => {
    mocks.verify.mockReset();
    mocks.returning.mockReset();
    mocks.verify.mockResolvedValue(event);
  });

  it("rejects an invalid signature or payload without touching the database", async () => {
    mocks.verify.mockRejectedValue(new Error("invalid signature"));
    const response = await postWebhook();
    expect(response.status).toBe(400);
    expect(mocks.returning).not.toHaveBeenCalled();
  });

  it("acknowledges a newly recorded event and an idempotent duplicate", async () => {
    mocks.returning.mockResolvedValueOnce([event]).mockResolvedValueOnce([]);
    const first = await postWebhook();
    const second = await postWebhook();
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ duplicate: true });
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({
      rawBody: '{"type":"email.delivered"}',
      headers: { id: "msg_1", timestamp: "1790121600", signature: "v1,test" },
    }));
  });

  it("requests provider retry when persistence fails, then records the redelivery", async () => {
    mocks.returning.mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValueOnce([event]);
    const unavailable = await postWebhook();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("database unavailable");
    const retry = await postWebhook();
    expect(retry.status).toBe(202);
    expect(mocks.returning).toHaveBeenCalledTimes(2);
  });
});
