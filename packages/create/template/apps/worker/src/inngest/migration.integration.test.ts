import { createDatabase, PostgresOutboxStore, tenantRecord } from "@__TRESTLE_PROJECT_NAME__/db";
import { dispatchOutbox, type QueuePublisher } from "@__TRESTLE_PROJECT_NAME__/events";
import { and, eq, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { conformanceEvent } from "../job-conformance.js";
import { cloudflareHarness } from "../job-conformance-cloudflare.js";
import { inngestHarness } from "./conformance-harness.js";

/**
 * `trestle jobs migrate`'s guarantee, against the real Inngest engine: moving
 * the dispatch owner between runtimes while work is pending, in flight on the
 * old runtime, or lost by it runs every committed event exactly once.
 */
const connectionString = process.env.TRESTLE_INNGEST_CONFORMANCE === "1" ? process.env.TRESTLE_RLS_TEST_DATABASE_URL : undefined;
const suite = connectionString ? describe : describe.skip;

suite("job runtime migration", () => {
  it("moves Cloudflare to Inngest and back with pending, in-flight, and lost work, running every event exactly once", async () => {
    const run = `mig${Date.now().toString(36)}`;
    const organizationId = `${run}-org`;
    const database = createDatabase(connectionString!, "postgres-js");
    const cloudflare = cloudflareHarness(connectionString!);
    const inngest = await inngestHarness(connectionString!);
    const commit = async (label: string) => {
      const outbox = new PostgresOutboxStore(connectionString!);
      try {
        const id = crypto.randomUUID();
        await outbox.append({ id, name: conformanceEvent.name, schemaVersion: conformanceEvent.schemaVersion, occurredAt: new Date().toISOString(), resource: { type: "conformance", id: label }, correlationId: `migration-${id}`, idempotencyKey: `${organizationId}:migration:${label}`, payload: { tag: `${run}-${label}`, failTimes: 0 } }, { organizationId });
      } finally { await outbox.close(); }
    };
    const dispatch = async (publisher: QueuePublisher) => {
      const store = new PostgresOutboxStore(connectionString!);
      try { while ((await dispatchOutbox(store, publisher)).sent > 0); } finally { await store.close(); }
    };
    const done = async (label: string) => (await database.select({ id: tenantRecord.id }).from(tenantRecord).where(and(eq(tenantRecord.organizationId, organizationId), like(tenantRecord.name, `done:${run}-${label}:%`)))).length;
    try {
      // On Cloudflare: three events accepted and still in flight, two committed but not yet dispatched.
      for (const label of ["a1", "a2", "a3"]) await commit(label);
      await dispatch(cloudflare.publisher);
      for (const label of ["a4", "a5"]) await commit(label);
      // Deploy with Inngest as the dispatch owner. New dispatches go to Inngest while Cloudflare drains what it accepted.
      await dispatch(inngest.publisher);
      await Promise.all([cloudflare.settle(), inngest.settle()]);
      for (const label of ["a1", "a2", "a3", "a4", "a5"]) expect(await done(label), label).toBe(1);

      // Back to Cloudflare. Inngest accepted b1 but lost the run before it executed (a cancel or a crash).
      await commit("b1");
      await dispatch({ send: async () => {} });
      await commit("b2");
      await dispatch(cloudflare.publisher);
      await cloudflare.settle();
      expect(await done("b1")).toBe(0);
      // `trestle jobs migrate --settle`: re-dispatch what no consumer completed to the current owner.
      const store = new PostgresOutboxStore(connectionString!);
      try { expect(await store.settleUnconsumed({ olderThanMs: 0 })).not.toHaveLength(0); } finally { await store.close(); }
      await dispatch(cloudflare.publisher);
      await cloudflare.settle();
      for (const label of ["b1", "b2"]) expect(await done(label), label).toBe(1);
      for (const label of ["a1", "a2", "a3", "a4", "a5"]) expect(await done(label), `${label} after returning`).toBe(1);
    } finally {
      await inngest.close();
      await database.delete(tenantRecord).where(like(tenantRecord.organizationId, `${run}%`));
      await database.$client.end();
    }
  }, 600_000);
});
