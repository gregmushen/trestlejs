import { describe, expect, it } from "vitest";

import { dailyAt, DueWorkScheduler, every, type DueWorkStorage } from "./scheduler.js";

/** Durable Object storage and its single alarm, held in memory with a manual clock. */
class FakeStorage implements DueWorkStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  alarmWrites = 0;
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    return new Map([...this.values].filter(([key]) => key.startsWith(options.prefix)).sort(([a], [b]) => a.localeCompare(b))) as Map<string, T>;
  }
  async getAlarm(): Promise<number | null> { return this.alarm; }
  async setAlarm(time: number): Promise<void> { this.alarm = time; this.alarmWrites++; }
  async deleteAlarm(): Promise<void> { this.alarm = null; }
}

function harness(runner: (key: string, dueAt: Date) => Promise<Date | null | { next: Date | null; wake?: Array<{ key: string; dueAt: Date }> }>) {
  let now = Date.parse("2026-09-25T12:00:00.000Z");
  const storage = new FakeStorage();
  const clock = { now: () => new Date(now) };
  const scheduler = new DueWorkScheduler(storage, runner, { clock });
  /** Fire the alarm the way the runtime does: only once its time has come, clearing it first. */
  const fire = async () => {
    if (storage.alarm === null || storage.alarm > now) return null;
    storage.alarm = null;
    return await scheduler.alarm();
  };
  return { storage, scheduler, fire, clock, advance: (ms: number) => { now += ms; }, at: (ms: number) => new Date(now + ms) };
}

describe("due-time scheduler", () => {
  it("is idle with nothing pending: no alarm and no work", async () => {
    const runs: string[] = [];
    const { storage, scheduler, fire } = harness(async (key) => { runs.push(key); return null; });
    expect(await scheduler.pending()).toEqual({ alarmAt: null, work: [] });
    expect(await scheduler.alarm()).toEqual({ ran: [], failed: [], alarmAt: null });
    expect(await fire()).toBeNull();
    expect(storage.alarm).toBeNull();
    expect(runs).toEqual([]);
  });

  it("arms the alarm for the earliest due time", async () => {
    const { storage, scheduler, at } = harness(async () => null);
    await scheduler.schedule([{ key: "job:digest", dueAt: at(60_000) }]);
    expect(storage.alarm).toBe(at(60_000).getTime());
    await scheduler.schedule([{ key: "framework:outbox", dueAt: at(5_000) }]);
    expect(storage.alarm).toBe(at(5_000).getTime());
    // A later time never delays an earlier one, for the alarm or for the same key.
    await scheduler.schedule([{ key: "framework:outbox", dueAt: at(90_000) }, { key: "job:other", dueAt: at(120_000) }]);
    expect(storage.alarm).toBe(at(5_000).getTime());
    expect((await scheduler.pending()).work).toEqual([
      { key: "framework:outbox", dueAt: at(5_000).toISOString() },
      { key: "job:digest", dueAt: at(60_000).toISOString() },
      { key: "job:other", dueAt: at(120_000).toISOString() },
    ]);
  });

  it("drains only due work and re-arms only while work remains", async () => {
    const runs: Array<{ key: string; dueAt: string }> = [];
    const { storage, scheduler, fire, advance, at } = harness(async (key, dueAt) => { runs.push({ key, dueAt: dueAt.toISOString() }); return null; });
    const first = at(1_000);
    await scheduler.schedule([{ key: "framework:outbox", dueAt: first }, { key: "job:digest", dueAt: at(10_000) }]);
    advance(1_000);
    expect(await fire()).toEqual({ ran: ["framework:outbox"], failed: [], alarmAt: at(9_000).getTime() });
    expect(runs).toEqual([{ key: "framework:outbox", dueAt: first.toISOString() }]);
    advance(9_000);
    expect(await fire()).toEqual({ ran: ["job:digest"], failed: [], alarmAt: null });
    expect(storage.alarm).toBeNull();
    expect(await scheduler.pending()).toEqual({ alarmAt: null, work: [] });
  });

  it("re-arms a key at the next due time its work reports", async () => {
    const { storage, scheduler, fire, advance, at } = harness(async () => new Date(Date.parse("2026-09-25T12:01:00.000Z") + 30_000));
    await scheduler.schedule([{ key: "framework:outbox", dueAt: at(60_000) }]);
    advance(60_000);
    const result = await fire();
    expect(result?.ran).toEqual(["framework:outbox"]);
    expect(storage.alarm).toBe(at(30_000).getTime());
  });

  it("never loses work recorded while the same key is running", async () => {
    let scheduleDuringRun: (() => Promise<void>) | undefined;
    const { scheduler, fire, advance, at } = harness(async () => { await scheduleDuringRun?.(); scheduleDuringRun = undefined; return null; });
    await scheduler.schedule([{ key: "framework:outbox", dueAt: at(0) }]);
    // A request commits a new event while the drain is between its lease query and its return.
    scheduleDuringRun = async () => { await scheduler.schedule([{ key: "framework:outbox", dueAt: at(0) }]); };
    expect((await fire())?.ran).toEqual(["framework:outbox"]);
    expect((await scheduler.pending()).work.map((item) => item.key)).toEqual(["framework:outbox"]);
    advance(1);
    expect((await fire())?.ran).toEqual(["framework:outbox"]);
    expect(await scheduler.pending()).toEqual({ alarmAt: null, work: [] });
  });

  it("backs off failed work per key and resets after success", async () => {
    let failing = true;
    const { storage, scheduler, fire, advance, at } = harness(async () => { if (failing) throw new Error("database unavailable"); return null; });
    await scheduler.schedule([{ key: "job:digest", dueAt: at(0) }]);
    expect(await fire()).toMatchObject({ ran: [], failed: ["job:digest"] });
    const firstRetry = storage.alarm!;
    expect(firstRetry).toBe(at(30_000).getTime());
    advance(30_000);
    await fire();
    expect(storage.alarm).toBe(at(60_000).getTime());
    advance(60_000);
    failing = false;
    expect((await fire())?.ran).toEqual(["job:digest"]);
    expect(storage.alarm).toBeNull();
    expect(await storage.get("failures:job:digest")).toBeUndefined();
  });

  it("bounds the work run by one alarm and continues immediately", async () => {
    const runs: string[] = [];
    let now = Date.parse("2026-09-25T12:00:00.000Z");
    const storage = new FakeStorage();
    const scheduler = new DueWorkScheduler(storage, async (key) => { runs.push(key); return null; }, { clock: { now: () => new Date(now) }, maxRunsPerAlarm: 2 });
    await scheduler.schedule(["a", "b", "c"].map((name, index) => ({ key: `job:${name}`, dueAt: new Date(now - 3 + index) })));
    storage.alarm = null;
    expect(await scheduler.alarm()).toEqual({ ran: ["job:a", "job:b"], failed: [], alarmAt: now - 1 });
    now += 1;
    storage.alarm = null;
    expect(await scheduler.alarm()).toEqual({ ran: ["job:c"], failed: [], alarmAt: null });
    expect(runs).toEqual(["job:a", "job:b", "job:c"]);
  });

  it("schedules follow-up work a run reports", async () => {
    const { scheduler, fire, at } = harness(async (key) => key === "job:digest" ? { next: null, wake: [{ key: "framework:outbox", dueAt: at(0) }] } : null);
    await scheduler.schedule([{ key: "job:digest", dueAt: at(0) }]);
    expect(await fire()).toEqual({ ran: ["job:digest"], failed: [], alarmAt: at(0).getTime() });
    expect(await fire()).toEqual({ ran: ["framework:outbox"], failed: [], alarmAt: null });
  });

  it("rejects malformed keys and times without storing anything", async () => {
    const { storage, scheduler } = harness(async () => null);
    await expect(scheduler.schedule([{ key: "", dueAt: new Date() }])).rejects.toThrow("due-work key");
    await expect(scheduler.schedule([{ key: "job:ok", dueAt: new Date(Number.NaN) }])).rejects.toThrow("due time");
    await expect(scheduler.schedule([{ key: "x".repeat(201), dueAt: new Date() }])).rejects.toThrow("due-work key");
    expect(storage.values.size).toBe(0);
    expect(storage.alarm).toBeNull();
  });
});

describe("due-time helpers", () => {
  it("every() returns the next aligned boundary after now", () => {
    const next = every({ minutes: 15 });
    expect(next(new Date("2026-09-25T12:00:00.000Z")).toISOString()).toBe("2026-09-25T12:15:00.000Z");
    expect(next(new Date("2026-09-25T12:07:31.000Z")).toISOString()).toBe("2026-09-25T12:15:00.000Z");
    expect(() => every({ minutes: 0 })).toThrow("minutes");
  });

  it("dailyAt() returns the next local wall-clock time across time zones and DST", () => {
    const sevenInLosAngeles = dailyAt({ hour: 7, minute: 0, timeZone: "America/Los_Angeles" });
    expect(sevenInLosAngeles(new Date("2026-09-25T12:00:00.000Z")).toISOString()).toBe("2026-09-25T14:00:00.000Z");
    expect(sevenInLosAngeles(new Date("2026-09-25T14:00:00.000Z")).toISOString()).toBe("2026-09-26T14:00:00.000Z");
    // After the November DST change, 07:00 Pacific is 15:00 UTC.
    expect(sevenInLosAngeles(new Date("2026-11-01T15:30:00.000Z")).toISOString()).toBe("2026-11-02T15:00:00.000Z");
    expect(dailyAt({ hour: 7, minute: 30, timeZone: "UTC" })(new Date("2026-09-25T08:00:00.000Z")).toISOString()).toBe("2026-09-26T07:30:00.000Z");
    expect(() => dailyAt({ hour: 24, minute: 0, timeZone: "UTC" })).toThrow("hour");
    expect(() => dailyAt({ hour: 7, minute: 0, timeZone: "Not/AZone" })).toThrow();
  });
});
