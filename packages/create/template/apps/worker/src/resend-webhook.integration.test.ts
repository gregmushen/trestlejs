import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { createDatabase, emailDeliveryEvent } from "@__TRESTLE_PROJECT_NAME__/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { app } from "./index.js";

const databaseUrl = process.env.TRESTLE_SYSTEM_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const signingKey = randomBytes(32);
const webhookSecret = `whsec_${signingKey.toString("base64")}`;

const environment = {
  DATABASE_URL: databaseUrl ?? "postgres://unused",
  DATABASE_DRIVER: "postgres-js" as const,
  BETTER_AUTH_SECRET: "signed-email-webhook-test-secret-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:8787",
  APP_ENV: "staging" as const,
  RESEND_API_KEY: "re_test",
  RESEND_WEBHOOK_SECRET: webhookSecret,
};

function signedEvent(options: { timestamp?: number; extra?: Record<string, unknown> } = {}) {
  const id = `msg_${randomUUID()}`;
  const emailDeliveryId = `email_${randomUUID()}`;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({
    type: "email.delivered",
    created_at: new Date().toISOString(),
    data: { email_id: emailDeliveryId, to: ["private@example.test"], ...options.extra },
  });
  const signature = `v1,${createHmac("sha256", signingKey).update(`${id}.${timestamp}.${rawBody}`).digest("base64")}`;
  return { id, emailDeliveryId, rawBody, headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": signature } };
}

async function post(event: ReturnType<typeof signedEvent>, overrides: Partial<typeof environment> = {}, body = event.rawBody) {
  return app.request("/api/webhooks/resend", { method: "POST", headers: event.headers, body }, { ...environment, ...overrides });
}

suite("signed Resend delivery webhook against PostgreSQL", () => {
  it("persists a verified event once and acknowledges a signed duplicate", async () => {
    const event = signedEvent();
    const database = createDatabase(databaseUrl!, "postgres-js");
    try {
      const first = await post(event);
      expect(first.status).toBe(202);
      await expect(first.json()).resolves.toMatchObject({ duplicate: false, event: { id: event.id, emailDeliveryId: event.emailDeliveryId, status: "delivered" } });
      const second = await post(event);
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toMatchObject({ duplicate: true });
      const rows = await database.select().from(emailDeliveryEvent).where(eq(emailDeliveryEvent.id, event.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: event.id, emailDeliveryId: event.emailDeliveryId, status: "delivered" });
      expect(JSON.stringify(rows[0])).not.toContain("private@example.test");
    } finally {
      await database.delete(emailDeliveryEvent).where(eq(emailDeliveryEvent.id, event.id));
    }
  });

  it("rejects a tampered raw body and an expired signature before persistence", async () => {
    const current = signedEvent();
    const tampered = await post(current, {}, `${current.rawBody} `);
    expect(tampered.status).toBe(400);
    const expired = signedEvent({ timestamp: Math.floor(Date.now() / 1000) - 86_400 });
    expect((await post(expired)).status).toBe(400);
    const database = createDatabase(databaseUrl!, "postgres-js");
    expect(await database.select().from(emailDeliveryEvent).where(eq(emailDeliveryEvent.id, current.id))).toHaveLength(0);
    expect(await database.select().from(emailDeliveryEvent).where(eq(emailDeliveryEvent.id, expired.id))).toHaveLength(0);
  });

  it("returns a retryable response during a database outage and records redelivery", async () => {
    const event = signedEvent();
    const database = createDatabase(databaseUrl!, "postgres-js");
    try {
      const unavailable = await post(event, { DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/unavailable" });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.text()).not.toContain(event.emailDeliveryId);
      expect(await database.select().from(emailDeliveryEvent).where(eq(emailDeliveryEvent.id, event.id))).toHaveLength(0);
      expect((await post(event)).status).toBe(202);
      expect(await database.select().from(emailDeliveryEvent).where(eq(emailDeliveryEvent.id, event.id))).toHaveLength(1);
    } finally {
      await database.delete(emailDeliveryEvent).where(eq(emailDeliveryEvent.id, event.id));
    }
  });
});
