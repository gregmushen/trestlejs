import { eventEnvelopeSchema } from "@__TRESTLE_PROJECT_NAME__/events";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { PostgresEventInbox } from "./inbox.js";

const databaseUrl = process.env.TRESTLE_INBOX_TEST_DATABASE_URL;
const adminUrl = process.env.TRESTLE_INBOX_TEST_ADMIN_DATABASE_URL ?? databaseUrl;
const suite = databaseUrl ? describe : describe.skip;

suite("durable Queue inbox", () => {
  it("suppresses completed duplicates and never runs two active claims", async () => {
    const key = `inbox:${crypto.randomUUID()}`;
    const event = eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "article.published", schemaVersion: 1, occurredAt: new Date().toISOString(), resource: { type: "article", id: crypto.randomUUID() }, correlationId: crypto.randomUUID(), idempotencyKey: key, payload: {} });
    const first = new PostgresEventInbox(databaseUrl!, { assumeApplicationRole: true });
    const second = new PostgresEventInbox(databaseUrl!, { assumeApplicationRole: true });
    const admin = postgres(adminUrl!, { max: 1, prepare: false });
    try {
      const claim = await first.claim(event);
      expect(claim.state).toBe("claimed");
      expect(await second.claim(event)).toEqual({ state: "busy" });
      if (claim.state !== "claimed") throw new Error("expected claim");
      await expect(second.complete(key, crypto.randomUUID())).rejects.toThrow("no longer active");
      await first.complete(key, claim.token);
      expect(await second.claim(event)).toEqual({ state: "completed" });
      expect((await admin`select attempts, status from event_inbox where idempotency_key = ${key}`)[0]).toMatchObject({ attempts: 1, status: "completed" });
      await expect(second.claim({ ...event, name: "article.deleted" })).rejects.toThrow("different event");
    } finally {
      await admin`delete from event_inbox where idempotency_key = ${key}`;
      await first.close();
      await second.close();
      await admin.end();
    }
  });

  it("reclaims failed and expired work without accepting a stale completion", async () => {
    const key = `inbox:${crypto.randomUUID()}`;
    const event = eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "article.published", schemaVersion: 1, occurredAt: new Date().toISOString(), resource: { type: "article", id: crypto.randomUUID() }, correlationId: crypto.randomUUID(), idempotencyKey: key, payload: {} });
    const inbox = new PostgresEventInbox(databaseUrl!, { assumeApplicationRole: true });
    const admin = postgres(adminUrl!, { max: 1, prepare: false });
    try {
      const first = await inbox.claim(event);
      if (first.state !== "claimed") throw new Error("expected claim");
      await inbox.release(key, first.token, new Error("sk_secret_should_never_persist"));
      expect((await admin`select last_error from event_inbox where idempotency_key = ${key}`)[0]).toMatchObject({ last_error: "Error" });
      const second = await inbox.claim(event);
      if (second.state !== "claimed") throw new Error("expected reclaimed event");
      await admin`update event_inbox set leased_until = now() - interval '1 second' where idempotency_key = ${key}`;
      const third = await inbox.claim(event);
      if (third.state !== "claimed") throw new Error("expected expired lease to be reclaimed");
      await expect(inbox.complete(key, second.token)).rejects.toThrow("no longer active");
      await inbox.complete(key, third.token);
      expect((await admin`select attempts, status from event_inbox where idempotency_key = ${key}`)[0]).toMatchObject({ attempts: 3, status: "completed" });
    } finally {
      await admin`delete from event_inbox where idempotency_key = ${key}`;
      await inbox.close();
      await admin.end();
    }
  });
});
