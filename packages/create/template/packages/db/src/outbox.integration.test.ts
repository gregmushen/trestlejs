import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresOutboxStore } from "./outbox.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const run = `obx${Date.now()}`;

suite("PostgreSQL outbox store", () => {
  const store = connectionString ? new PostgresOutboxStore(connectionString) : undefined;
  const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;

  afterAll(async () => {
    await sql!`delete from outbox_message where correlation_id = ${run}`;
    await sql!.end();
    await store!.close();
  });

  it("leases real application events and dead-letters malformed rows without blocking the batch", async () => {
    const good = await store!.append({ id: crypto.randomUUID(), name: "access.api_key.minted", schemaVersion: 1, occurredAt: new Date(Date.now() - 1_000).toISOString(), resource: { type: "api_key", id: "k1" }, correlationId: run, idempotencyKey: `${run}:good`, payload: { organizationId: "org" } });
    const bad = crypto.randomUUID();
    await sql!`insert into outbox_message (id, event_name, schema_version, occurred_at, resource_type, resource_id, correlation_id, idempotency_key, payload, available_at) values (${bad}, 'Not A Valid Name', 1, now(), 't', '1', ${run}, ${`${run}:bad`}, '{}', now() - interval '1 second')`;
    const leased = await store!.lease(1_000, 60_000);
    expect(leased.map((entry) => entry.id)).toContain(good.id);
    expect(leased.map((entry) => entry.id)).not.toContain(bad);
    expect((await sql!`select status, last_error from outbox_message where id = ${bad}`)[0]).toMatchObject({ status: "dead", last_error: "invalid event envelope" });
    await store!.succeed(good.id);
    // Release anything else this lease picked up so other suites are unaffected.
    await sql!`update outbox_message set status = 'pending', leased_until = null where status = 'leased' and correlation_id <> ${run}`;
  });
});
