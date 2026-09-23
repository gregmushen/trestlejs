import { eventEnvelopeSchema } from "@__TRESTLE_PROJECT_NAME__/events";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { PostgresOutboxStore } from "./outbox.js";

const databaseUrl = process.env.TRESTLE_INBOX_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("outbox retention and failure redaction", () => {
  it("retrieves tenant provenance only from the committed record", async () => {
    const sql = postgres(databaseUrl!, { max: 1, prepare: false });
    const store = new PostgresOutboxStore(databaseUrl!);
    const id = crypto.randomUUID();
    const message = eventEnvelopeSchema.parse({ id, name: "article.published", schemaVersion: 1, occurredAt: new Date().toISOString(), resource: { type: "article", id }, correlationId: id, idempotencyKey: id, payload: { resourceId: id } });
    try {
      const inserted = await store.append(message, { organizationId: "org-trusted" });
      expect(inserted.organizationId).toBe("org-trusted");
      expect(inserted.message).not.toHaveProperty("organizationId");
      expect((await store.findCommitted(id))?.organizationId).toBe("org-trusted");
      await expect(store.append({ ...message, id: crypto.randomUUID() }, { organizationId: "org-other" })).rejects.toThrow("different organization");
      expect((await sql`select organization_id, payload from outbox_message where id=${id}`)[0]).toEqual({ organization_id: "org-trusted", payload: { resourceId: id } });
      expect(await store.findCommitted(crypto.randomUUID())).toBeNull();
    } finally {
      await sql`delete from outbox_message where id=${id}`;
      await store.close();
      await sql.end();
    }
  });
  it("prunes only old succeeded records in bounded batches while preserving dead and pending work", async () => {
    const sql = postgres(databaseUrl!, { max: 1, prepare: false });
    const store = new PostgresOutboxStore(databaseUrl!);
    const ids: string[] = [];
    const create = async () => {
      const id = crypto.randomUUID();
      ids.push(id);
      await store.append(eventEnvelopeSchema.parse({ id, name: "article.published", schemaVersion: 1, occurredAt: new Date().toISOString(), resource: { type: "article", id }, correlationId: id, idempotencyKey: id, payload: {} }));
      return id;
    };
    try {
      const oldA = await create();
      const oldB = await create();
      const recent = await create();
      const dead = await create();
      const pending = await create();
      for (const id of [oldA, oldB]) await sql`update outbox_message set status='succeeded', processed_at=now()-interval '3 days' where id=${id}`;
      await sql`update outbox_message set status='succeeded', processed_at=now() where id=${recent}`;
      await sql`update outbox_message set status='dead', processed_at=now()-interval '3 days' where id=${dead}`;
      const cutoff = new Date(Date.now() - 86_400_000);
      expect(await store.countPrunableSucceeded(cutoff)).toBe(2);
      expect(await store.pruneSucceeded(cutoff, 1)).toBe(1);
      expect(await store.countPrunableSucceeded(cutoff)).toBe(1);
      expect(await store.pruneSucceeded(cutoff, 10)).toBe(1);
      expect(await store.countPrunableSucceeded(cutoff)).toBe(0);
      expect((await sql`select id from outbox_message where id in (${recent},${dead},${pending})`).map((row) => row.id).sort()).toEqual([recent, dead, pending].sort());
      await sql`update outbox_message set status='leased' where id=${pending}`;
      const error = new Error("sk_sensitive-provider-key");
      error.name = "Secret sk_sensitive-provider-key";
      await store.fail(pending, error, 1);
      expect((await sql`select status, last_error from outbox_message where id=${pending}`)[0]).toEqual({ status: "dead", last_error: "Error" });
      await expect(store.pruneSucceeded(new Date("invalid"))).rejects.toThrow("Invalid outbox retention parameters");
      await expect(store.pruneSucceeded(cutoff, 10_001)).rejects.toThrow("Invalid outbox retention parameters");
    } finally {
      await sql`delete from outbox_message where id = any(${ids})`;
      await store.close();
      await sql.end();
    }
  });
});
