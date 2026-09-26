import type { ScheduledJobAcquisition, ScheduledJobStore } from "@__TRESTLE_PROJECT_NAME__/db";
import { defineEvent, defineEventCatalog } from "@__TRESTLE_PROJECT_NAME__/events";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createEventPublisher } from "./events.js";
import { ScheduledJobRegistry, type ScheduledJobEnvironment } from "./scheduled-jobs.js";
import { every } from "./scheduler.js";

const reminderPayload = z.object({ reminderId: z.string().min(1) });
const catalog = defineEventCatalog([defineEvent({
  name: "reminder.due", schemaVersion: 1, description: "A reminder became due", sensitivity: "internal", payload: reminderPayload,
  resource: { type: "reminder", id: (value: z.infer<typeof reminderPayload>) => value.reminderId },
})]);

/** The PostgreSQL store's contract in memory, with a controllable clock. */
class MemoryJobStore implements ScheduledJobStore {
  readonly rows = new Map<string, { token: string | null; leasedUntil: number | null; completedDueAt: number | null; failures: number }>();
  readonly calls: string[] = [];
  constructor(private readonly now: () => number) {}
  async acquire(name: string, dueAt: Date, leaseMs: number): Promise<ScheduledJobAcquisition> {
    this.calls.push(`acquire:${name}`);
    const row = this.rows.get(name) ?? { token: null, leasedUntil: null, completedDueAt: null, failures: 0 };
    if (row.completedDueAt !== null && row.completedDueAt >= dueAt.getTime()) return { state: "completed", completedDueAt: new Date(row.completedDueAt) };
    if (row.leasedUntil !== null && row.leasedUntil > this.now()) return { state: "busy", leasedUntil: new Date(row.leasedUntil) };
    const token = crypto.randomUUID();
    this.rows.set(name, { ...row, token, leasedUntil: this.now() + leaseMs });
    return { state: "acquired", token, leasedUntil: new Date(this.now() + leaseMs) };
  }
  async holds(name: string, token: string): Promise<boolean> {
    const row = this.rows.get(name);
    return row?.token === token && (row.leasedUntil ?? 0) > this.now();
  }
  async complete(name: string, token: string, dueAt: Date, options: { more?: boolean } = {}): Promise<void> {
    this.calls.push(`complete:${name}${options.more ? ":more" : ""}`);
    const row = this.rows.get(name);
    if (!row || row.token !== token || (row.leasedUntil ?? 0) <= this.now()) throw Object.assign(new Error("lease lost"), { name: "ScheduledJobLeaseLostError" });
    this.rows.set(name, { token: null, leasedUntil: null, failures: 0, completedDueAt: options.more ? row.completedDueAt : Math.max(row.completedDueAt ?? dueAt.getTime(), dueAt.getTime()) });
  }
  async fail(name: string, token: string): Promise<number> {
    this.calls.push(`fail:${name}`);
    const row = this.rows.get(name);
    if (!row || row.token !== token) throw Object.assign(new Error("lease lost"), { name: "ScheduledJobLeaseLostError" });
    const failures = row.failures + 1;
    this.rows.set(name, { ...row, token: null, leasedUntil: null, failures });
    return failures;
  }
}

type Data = { organizationId: string; closed: boolean };

function setup(options: { now?: number } = {}) {
  let now = options.now ?? Date.parse("2026-09-25T12:00:00.000Z");
  const store = new MemoryJobStore(() => now);
  const opened: Data[] = [];
  const scheduled: Array<{ key: string; dueAt: string }> = [];
  const logs: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  const log = (level: string) => (event: string, fields: Record<string, unknown> = {}) => { logs.push({ level, event, fields }); };
  const registry = new ScheduledJobRegistry<ScheduledJobEnvironment, Data>({
    store: () => ({ store, close: async () => {} }),
    tenantData: (_environment, organizationId) => { const data = { organizationId, closed: false }; opened.push(data); return data; },
    closeTenantData: async (data) => { data.closed = true; },
    events: (organizationId, correlationId, clock) => createEventPublisher({ organizationId, correlationId, clock, catalog }),
    clock: { now: () => new Date(now) },
    logger: () => { const logger = { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error"), child: () => logger }; return logger; },
  });
  const environment: ScheduledJobEnvironment = {
    DATABASE_URL: "postgres://unused",
    TRESTLE_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ schedule: async (items: Array<{ key: string; dueAt: string }>) => { scheduled.push(...items); } }),
    },
  };
  return { registry, store, opened, scheduled, logs, environment, advance: (ms: number) => { now += ms; }, now: () => now };
}

const noop = async () => {};

describe("application due-work registration", () => {
  it("validates registrations and refuses duplicates", () => {
    const { registry } = setup();
    registry.register("digests.daily", { next: every({ minutes: 15 }), run: noop });
    expect(() => registry.register("digests.daily", { next: every({ minutes: 15 }), run: noop })).toThrow("already registered");
    expect(() => registry.register("Bad Name", { next: every({ minutes: 15 }), run: noop })).toThrow("job name");
    expect(() => registry.register("slow.job", { next: every({ minutes: 15 }), run: noop, leaseMs: 900_001 })).toThrow("leaseMs");
    expect(() => registry.register("big.job", { next: every({ minutes: 15 }), run: noop, limit: 0 })).toThrow("limit");
    expect(() => registry.register("no.run", { next: every({ minutes: 15 }) } as never)).toThrow("run");
    expect(registry.names()).toEqual(["digests.daily"]);
  });

  it("runs a due job once under its lease and re-arms at the job's next due time", async () => {
    const { registry, store, environment, now } = setup();
    const contexts: Array<{ dueAt: string; limit: number; token: string }> = [];
    registry.register("weather.refresh", {
      next: every({ minutes: 15 }),
      limit: 25,
      run: async (context) => { contexts.push({ dueAt: context.dueAt.toISOString(), limit: context.limit, token: context.lease.token }); expect(await context.lease.held()).toBe(true); },
    });
    const dueAt = new Date(now());
    const result = await registry.run("weather.refresh", dueAt, environment);
    expect(result).toEqual({ outcome: "ran", next: new Date("2026-09-25T12:15:00.000Z"), wake: [] });
    expect(contexts).toEqual([{ dueAt: dueAt.toISOString(), limit: 25, token: expect.any(String) }]);
    expect(store.calls).toEqual(["acquire:weather.refresh", "complete:weather.refresh"]);
  });

  it("never double-processes when runs overlap or repeat for the same due slot", async () => {
    const { registry, environment, now } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    registry.register("digests.daily", { next: every({ minutes: 60 }), leaseMs: 60_000, run: async () => { runs++; await gate; } });
    const dueAt = new Date(now());
    const first = registry.run("digests.daily", dueAt, environment);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const overlapping = await registry.run("digests.daily", dueAt, environment);
    // The overlapping run defers until the holder's lease would expire.
    expect(overlapping).toEqual({ outcome: "busy", next: new Date(now() + 60_000), wake: [] });
    release();
    expect((await first).outcome).toBe("ran");
    const repeated = await registry.run("digests.daily", dueAt, environment);
    expect(repeated).toEqual({ outcome: "completed", next: new Date("2026-09-25T13:00:00.000Z"), wake: [] });
    expect(runs).toBe(1);
  });

  it("continues a bounded run immediately when it reports more work", async () => {
    const { registry, store, environment, now } = setup();
    registry.register("backfill.batch", { next: () => null, run: async () => ({ more: true }) });
    expect(await registry.run("backfill.batch", new Date(now()), environment)).toEqual({ outcome: "ran", next: new Date(now()), wake: [] });
    expect(store.calls).toContain("complete:backfill.batch:more");
  });

  it("floors a still-due next time so a job cannot spin", async () => {
    const { registry, environment, now } = setup();
    registry.register("stuck.job", { next: ({ now: current }) => new Date(current.getTime() - 60_000), run: noop });
    expect(await registry.run("stuck.job", new Date(now()), environment)).toMatchObject({ outcome: "ran", next: new Date(now() + 1_000) });
  });

  it("records a failed run, backs off, and logs only a safe category", async () => {
    const { registry, store, environment, logs, now } = setup();
    registry.register("flaky.job", { next: every({ minutes: 5 }), run: async () => { throw new TypeError("token sk_live_secret rejected"); } });
    expect(await registry.run("flaky.job", new Date(now()), environment)).toEqual({ outcome: "failed", next: new Date(now() + 30_000), wake: [] });
    expect(store.calls).toEqual(["acquire:flaky.job", "fail:flaky.job"]);
    const failure = logs.find((entry) => entry.event === "scheduler.job.failed");
    expect(failure?.fields).toEqual({ job: "flaky.job", errorCategory: "TypeError", failures: 1 });
    expect(JSON.stringify(logs)).not.toContain("sk_live_secret");
  });

  it("gates a job on its declared capability", async () => {
    const { registry, environment, logs, now } = setup();
    let runs = 0;
    registry.register("events.fanout", { requires: { capability: "queues" }, next: every({ minutes: 5 }), run: async () => { runs++; } });
    expect(await registry.run("events.fanout", new Date(now()), environment)).toEqual({ outcome: "skipped", next: null, wake: [] });
    expect(logs.find((entry) => entry.event === "scheduler.job.skipped")?.fields).toEqual({ job: "events.fanout", reason: "capability_unavailable", capability: "queues" });
    expect(await registry.due(environment, new Date(now()))).toEqual([]);
    const withQueue = { ...environment, TRESTLE_EVENTS: { send: async () => {} } };
    expect((await registry.run("events.fanout", new Date(now()), withQueue)).outcome).toBe("ran");
    expect(runs).toBe(1);
  });

  it("opens tenant data lazily, closes it after the run, and wakes outbox dispatch for emitted events", async () => {
    const { registry, opened, environment, now } = setup();
    registry.register("reminders.send", {
      next: () => null,
      run: async (context) => {
        const first = context.tenant("org_1");
        expect(context.tenant("org_1").data).toBe(first.data);
        first.events.statement("reminder.due", { reminderId: "reminder-1" }, { idempotencyKey: `reminder:1:${context.dueAt.toISOString()}` });
      },
    });
    const result = await registry.run("reminders.send", new Date(now()), environment);
    expect(result).toEqual({ outcome: "ran", next: null, wake: [{ key: "framework:outbox", dueAt: new Date(now()) }] });
    expect(opened).toEqual([{ organizationId: "org_1", closed: true }]);
  });

  it("closes tenant data after a failed run too", async () => {
    const { registry, opened, environment, now } = setup();
    registry.register("reminders.fail", { next: () => null, run: async (context) => { context.tenant("org_2"); throw new Error("boom"); } });
    expect((await registry.run("reminders.fail", new Date(now()), environment)).outcome).toBe("failed");
    expect(opened).toEqual([{ organizationId: "org_2", closed: true }]);
  });

  it("aborts the run's signal before its lease expires and retries when the lease was lost", async () => {
    const { registry, environment, advance, now } = setup();
    let aborted = false;
    registry.register("slow.job", {
      next: every({ minutes: 5 }), leaseMs: 1_000,
      run: async (context) => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        aborted = context.signal.aborted;
        advance(2_000);
      },
    });
    expect(await registry.run("slow.job", new Date(now()), environment)).toEqual({ outcome: "lease_lost", next: new Date(now()), wake: [] });
    expect(aborted).toBe(true);
  });

  it("records a job's due time with the scheduler after the caller commits new work", async () => {
    const { registry, scheduled, environment } = setup();
    registry.register("digests.daily", { next: every({ minutes: 60 }), run: noop });
    expect(await registry.notify(environment, "digests.daily", new Date("2026-09-26T14:00:00.000Z"))).toBe(true);
    expect(scheduled).toEqual([{ key: "job:digests.daily", dueAt: "2026-09-26T14:00:00.000Z" }]);
    await expect(registry.notify(environment, "unknown.job", new Date())).rejects.toThrow("not registered");
    expect(await registry.notify({ DATABASE_URL: "postgres://unused" }, "digests.daily", new Date())).toBe(false);
  });

  it("lists every enabled job's next due time for the safety sweep", async () => {
    const { registry, environment, now } = setup();
    registry.register("a.job", { next: every({ minutes: 15 }), run: noop });
    registry.register("b.job", { next: () => null, run: noop });
    registry.register("c.job", { next: async () => { throw new Error("database unavailable"); }, run: noop });
    expect(await registry.due(environment, new Date(now()))).toEqual([{ key: "job:a.job", dueAt: new Date("2026-09-25T12:15:00.000Z") }]);
  });
});
