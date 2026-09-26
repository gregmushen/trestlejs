import { eventEnvelopeSchema } from "@__TRESTLE_PROJECT_NAME__/events";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { PostgresOutboxStore } from "./outbox.js";
import { PostgresScheduledJobStore, ScheduledJobLeaseLostError } from "./scheduled-jobs.js";

const databaseUrl = process.env.TRESTLE_INBOX_TEST_DATABASE_URL;
const adminUrl = process.env.TRESTLE_INBOX_TEST_ADMIN_DATABASE_URL ?? databaseUrl;
const suite = databaseUrl ? describe : describe.skip;

const jobName = () => `test.job-${crypto.randomUUID().slice(0, 8)}`;

suite("scheduled job leases", () => {
  it("lets exactly one of many overlapping runs hold a job's lease", async () => {
    const name = jobName();
    const slot = new Date("2026-09-25T07:00:00.000Z");
    const stores = Array.from({ length: 8 }, () => new PostgresScheduledJobStore(databaseUrl!, { assumeApplicationRole: true }));
    const admin = postgres(adminUrl!, { max: 1, prepare: false });
    try {
      const results = await Promise.all(stores.map(async (store) => await store.acquire(name, slot, 60_000)));
      expect(results.filter((result) => result.state === "acquired")).toHaveLength(1);
      expect(results.filter((result) => result.state === "busy")).toHaveLength(7);
    } finally {
      await admin`delete from scheduled_job where name = ${name}`;
      await Promise.all(stores.map(async (store) => await store.close()));
      await admin.end();
    }
  });

  it("fences completion by lease token and never re-runs a completed due slot", async () => {
    const name = jobName();
    const slot = new Date("2026-09-25T07:00:00.000Z");
    const first = new PostgresScheduledJobStore(databaseUrl!, { assumeApplicationRole: true });
    const second = new PostgresScheduledJobStore(databaseUrl!, { assumeApplicationRole: true });
    const admin = postgres(adminUrl!, { max: 1, prepare: false });
    try {
      const lease = await first.acquire(name, slot, 60_000);
      if (lease.state !== "acquired") throw new Error("expected the first lease");
      expect(await second.acquire(name, slot, 60_000)).toMatchObject({ state: "busy" });
      await expect(second.complete(name, crypto.randomUUID(), slot)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
      expect(await first.holds(name, lease.token)).toBe(true);
      await first.complete(name, lease.token, slot);
      expect(await first.holds(name, lease.token)).toBe(false);
      // A late duplicate for the same due slot is recognized as already done.
      expect(await second.acquire(name, slot, 60_000)).toEqual({ state: "completed", completedDueAt: slot });
      expect(await second.acquire(name, new Date(slot.getTime() - 60_000), 60_000)).toEqual({ state: "completed", completedDueAt: slot });
      const later = await second.acquire(name, new Date(slot.getTime() + 1), 60_000);
      expect(later.state).toBe("acquired");
      const [row] = await admin`select completed_due_at, failures, lease_token from scheduled_job where name = ${name}`;
      expect(row).toMatchObject({ completed_due_at: slot, failures: 0 });
    } finally {
      await admin`delete from scheduled_job where name = ${name}`;
      await first.close();
      await second.close();
      await admin.end();
    }
  });

  it("reclaims an expired lease and rejects the stale holder's completion", async () => {
    const name = jobName();
    const slot = new Date("2026-09-25T07:00:00.000Z");
    const store = new PostgresScheduledJobStore(databaseUrl!, { assumeApplicationRole: true });
    const admin = postgres(adminUrl!, { max: 1, prepare: false });
    try {
      const stale = await store.acquire(name, slot, 1);
      if (stale.state !== "acquired") throw new Error("expected the first lease");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await store.holds(name, stale.token)).toBe(false);
      const fresh = await store.acquire(name, slot, 60_000);
      if (fresh.state !== "acquired") throw new Error("expected the expired lease to be reclaimed");
      expect(fresh.token).not.toBe(stale.token);
      await expect(store.complete(name, stale.token, slot)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
      await expect(store.fail(name, stale.token, new Error("late"))).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
      await store.complete(name, fresh.token, slot);
    } finally {
      await admin`delete from scheduled_job where name = ${name}`;
      await store.close();
      await admin.end();
    }
  });

  it("records failures without completing the slot, and continues a partial run", async () => {
    const name = jobName();
    const slot = new Date("2026-09-25T07:00:00.000Z");
    const store = new PostgresScheduledJobStore(databaseUrl!, { assumeApplicationRole: true });
    const admin = postgres(adminUrl!, { max: 1, prepare: false });
    try {
      const failed = await store.acquire(name, slot, 60_000);
      if (failed.state !== "acquired") throw new Error("expected a lease");
      expect(await store.fail(name, failed.token, new TypeError("provider secret sk_live_123 rejected"))).toBe(1);
      const [afterFailure] = await admin`select failures, last_error, completed_due_at, lease_token from scheduled_job where name = ${name}`;
      // Only a safe category is stored, never the message.
      expect(afterFailure).toMatchObject({ failures: 1, last_error: "TypeError", completed_due_at: null, lease_token: null });
      const partial = await store.acquire(name, slot, 60_000);
      if (partial.state !== "acquired") throw new Error("a failed slot must be retryable");
      await store.complete(name, partial.token, slot, { more: true });
      // More work remains for this slot, so it is not yet complete.
      const rest = await store.acquire(name, slot, 60_000);
      if (rest.state !== "acquired") throw new Error("a partial slot must continue");
      await store.complete(name, rest.token, slot);
      expect(await store.acquire(name, slot, 60_000)).toMatchObject({ state: "completed" });
      const [done] = await admin`select failures, last_error from scheduled_job where name = ${name}`;
      expect(done).toMatchObject({ failures: 0, last_error: null });
    } finally {
      await admin`delete from scheduled_job where name = ${name}`;
      await store.close();
      await admin.end();
    }
  });

  it("rejects invalid job names and lease durations", async () => {
    const store = new PostgresScheduledJobStore(databaseUrl!, { assumeApplicationRole: true });
    try {
      await expect(store.acquire("Bad Name", new Date(), 60_000)).rejects.toThrow("job name");
      await expect(store.acquire(jobName(), new Date(), 0)).rejects.toThrow("lease");
      await expect(store.acquire(jobName(), new Date(Number.NaN), 60_000)).rejects.toThrow("due time");
    } finally {
      await store.close();
    }
  });
});

suite("outbox due time", () => {
  it("reports when pending or leased outbox work is next due", async () => {
    const store = new PostgresOutboxStore(databaseUrl!, { assumeApplicationRole: true });
    const admin = postgres(adminUrl!, { max: 1, prepare: false });
    const key = `due:${crypto.randomUUID()}`;
    try {
      const future = new Date(Date.now() + 3_600_000);
      const event = eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "article.published", schemaVersion: 1, occurredAt: future.toISOString(), resource: { type: "article", id: crypto.randomUUID() }, correlationId: crypto.randomUUID(), idempotencyKey: key, payload: {} });
      await store.append(event);
      const next = await store.nextDue();
      expect(next).toBeInstanceOf(Date);
      expect(next!.getTime()).toBeLessThanOrEqual(future.getTime());
      await admin`update outbox_message set status = 'succeeded' where idempotency_key = ${key}`;
    } finally {
      await admin`delete from outbox_message where idempotency_key = ${key}`;
      await store.close();
      await admin.end();
    }
  });
});
