/**
 * The due-time scheduler: one Durable Object acts as a dirty flag for future
 * work. Code that creates future work records its due time here; the object
 * keeps one alarm for the earliest due time; the alarm drains due work and
 * re-arms only while work remains. With nothing pending there is no alarm, so
 * nothing wakes and nothing connects to the database.
 *
 * This module has no Cloudflare imports so it runs under unit tests with fake
 * storage and a manual clock. `scheduler-object.ts` binds it to the runtime.
 *
 * The scheduler is an optimization over durable state, never the source of
 * truth: the outbox and the application's own tables stay authoritative, and
 * the safety sweep re-records due times it finds, so a lost notification is
 * delayed until the next sweep rather than dropped.
 */

/** A unit of future work: `framework:*` keys are framework-owned; `job:<name>` keys are application jobs. */
export type DueWorkItem = { key: string; dueAt: Date | string | number };
/** What a run reports: when the key is next due (null when nothing remains) and other keys it made due. */
export type DueWorkOutcome = { next: Date | null; wake?: DueWorkItem[] };
export type DueWorkRunner = (key: string, dueAt: Date) => Promise<Date | null | DueWorkOutcome>;

/** The subset of Durable Object storage the scheduler uses. */
export interface DueWorkStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export type DueWorkSchedulerOptions = {
  clock?: { now(): Date };
  /** Work run by one alarm invocation; the rest continues on an immediate re-arm. */
  maxRunsPerAlarm?: number;
  /** Delay before retrying a key whose run threw, by consecutive failure count. */
  retryDelayMs?: (failures: number) => number;
  onError?: (key: string, error: unknown) => void;
};

const duePrefix = "due:";
const failurePrefix = "failures:";
const keyPattern = /^[A-Za-z][A-Za-z0-9._:-]{0,199}$/u;

export function validDueWorkKey(key: unknown): key is string {
  return typeof key === "string" && keyPattern.test(key);
}

function dueTime(value: Date | string | number): number {
  const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;
  if (typeof time !== "number" || !Number.isFinite(time)) throw new Error("Invalid due time");
  return time;
}

function normalize(items: readonly DueWorkItem[]): Array<{ key: string; time: number }> {
  if (!Array.isArray(items) || items.length > 100) throw new Error("Due work must be a list of at most 100 items");
  return items.map((item) => {
    if (!validDueWorkKey(item?.key)) throw new Error("Invalid due-work key");
    return { key: item.key, time: dueTime(item.dueAt) };
  });
}

export const defaultRetryDelayMs = (failures: number): number => Math.min(60 * 60_000, 30_000 * 2 ** Math.min(Math.max(failures - 1, 0), 7));

export class DueWorkScheduler {
  private readonly clock: { now(): Date };
  private readonly maxRunsPerAlarm: number;
  private readonly retryDelayMs: (failures: number) => number;

  constructor(private readonly storage: DueWorkStorage, private readonly runner: DueWorkRunner, private readonly options: DueWorkSchedulerOptions = {}) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.maxRunsPerAlarm = options.maxRunsPerAlarm ?? 25;
    this.retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
    if (!Number.isInteger(this.maxRunsPerAlarm) || this.maxRunsPerAlarm < 1 || this.maxRunsPerAlarm > 1_000) throw new Error("maxRunsPerAlarm must be between 1 and 1000");
  }

  /** Record due times. Each key keeps its earliest time; the alarm moves only earlier. */
  async schedule(items: readonly DueWorkItem[]): Promise<void> {
    const work = normalize(items);
    let earliest: number | null = null;
    for (const { key, time } of work) {
      await this.merge(key, time);
      earliest = earliest === null ? time : Math.min(earliest, time);
    }
    if (earliest === null) return;
    const current = await this.storage.getAlarm();
    if (current === null || earliest < current) await this.storage.setAlarm(earliest);
  }

  /** Run due work, oldest first and bounded, then re-arm for what remains or clear the alarm. */
  async alarm(): Promise<{ ran: string[]; failed: string[]; alarmAt: number | null }> {
    const now = this.clock.now().getTime();
    const due = [...(await this.storage.list<number>({ prefix: duePrefix }))]
      .filter(([, time]) => time <= now)
      .sort(([keyA, a], [keyB, b]) => a - b || keyA.localeCompare(keyB))
      .slice(0, this.maxRunsPerAlarm);
    const ran: string[] = [];
    const failed: string[] = [];
    for (const [storageKey, time] of due) {
      const key = storageKey.slice(duePrefix.length);
      // Claim the key before running: a schedule() that arrives while the work
      // runs writes a fresh entry, which the merge below keeps.
      await this.storage.delete(storageKey);
      let next: number | null;
      try {
        const outcome = await this.runner(key, new Date(time));
        const normalized = outcome === null || outcome instanceof Date ? { next: outcome } : outcome;
        next = normalized.next === null ? null : dueTime(normalized.next);
        for (const item of normalize(normalized.wake ?? [])) await this.merge(item.key, item.time);
        await this.storage.delete(`${failurePrefix}${key}`);
        ran.push(key);
      } catch (error) {
        const failures = ((await this.storage.get<number>(`${failurePrefix}${key}`)) ?? 0) + 1;
        await this.storage.put(`${failurePrefix}${key}`, failures);
        next = now + this.retryDelayMs(failures);
        failed.push(key);
        this.options.onError?.(key, error);
      }
      if (next !== null) await this.merge(key, next);
    }
    return { ran, failed, alarmAt: await this.arm() };
  }

  /** The object's own state answers "anything pending?" without a database. */
  async pending(): Promise<{ alarmAt: string | null; work: Array<{ key: string; dueAt: string }> }> {
    const alarm = await this.storage.getAlarm();
    const work = [...(await this.storage.list<number>({ prefix: duePrefix }))]
      .sort(([keyA, a], [keyB, b]) => a - b || keyA.localeCompare(keyB))
      .map(([key, time]) => ({ key: key.slice(duePrefix.length), dueAt: new Date(time).toISOString() }));
    return { alarmAt: alarm === null ? null : new Date(alarm).toISOString(), work };
  }

  private async merge(key: string, time: number): Promise<void> {
    const existing = await this.storage.get<number>(`${duePrefix}${key}`);
    if (existing === undefined || time < existing) await this.storage.put(`${duePrefix}${key}`, time);
  }

  private async arm(): Promise<number | null> {
    let earliest: number | null = null;
    for (const time of (await this.storage.list<number>({ prefix: duePrefix })).values()) earliest = earliest === null ? time : Math.min(earliest, time);
    if (earliest === null) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(earliest);
    return earliest;
  }
}

/** Next due time for "every N minutes" work: the next UTC-aligned boundary strictly after `now`. */
/** A next-due function usable directly as a job's `next`, or called with a Date. */
export type NextDue = (input: Date | { now: Date }) => Date;
const instant = (input: Date | { now: Date }): Date => input instanceof Date ? input : input.now;

export function every(interval: { minutes: number }): NextDue {
  const minutes = interval.minutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) throw new Error("every() minutes must be an integer from 1 to 1440");
  const step = minutes * 60_000;
  return (input) => new Date(Math.floor(instant(input).getTime() / step) * step + step);
}

function zonedParts(formatter: Intl.DateTimeFormat, time: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(time)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

/** Next due time for "daily at local HH:MM" work, correct across DST changes. */
export function dailyAt(input: { hour: number; minute: number; timeZone: string }): NextDue {
  const { hour, minute, timeZone } = input;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("dailyAt() hour must be an integer from 0 to 23");
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("dailyAt() minute must be an integer from 0 to 59");
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const offset = (time: number) => {
    const parts = zonedParts(formatter, time);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - (time - (((time % 1_000) + 1_000) % 1_000));
  };
  const localToUtc = (year: number, month: number, day: number) => {
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    const first = wall - offset(wall);
    const second = wall - offset(first);
    return second;
  };
  return (value) => {
    const now = instant(value);
    const today = zonedParts(formatter, now.getTime());
    let candidate = localToUtc(today.year, today.month, today.day);
    if (candidate <= now.getTime()) {
      const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
      candidate = localToUtc(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate());
    }
    return new Date(candidate);
  };
}

/** The Worker's Durable Object namespace binding for the scheduler (`TRESTLE_SCHEDULER`). */
export type DueWorkSchedulerBinding = {
  idFromName(name: string): unknown;
  get(id: unknown): {
    schedule(items: Array<{ key: string; dueAt: string }>): Promise<unknown>;
    pending?(): Promise<{ alarmAt: string | null; work: Array<{ key: string; dueAt: string }> }>;
  };
};

/** There is exactly one scheduler object per Worker environment. */
export const schedulerObjectName = "trestle-scheduler";

export function schedulerStub(binding: DueWorkSchedulerBinding) {
  return binding.get(binding.idFromName(schedulerObjectName));
}

/**
 * Record due times with the scheduler. Call it only after the work that makes
 * something due has committed: an earlier notification can fire before the
 * work is visible. Returns false when no scheduler is bound (the safety sweep
 * then finds the work).
 */
export async function scheduleDueWork(binding: DueWorkSchedulerBinding | undefined, items: readonly DueWorkItem[]): Promise<boolean> {
  const work = normalize(items);
  if (!binding) return false;
  if (work.length === 0) return true;
  await schedulerStub(binding).schedule(work.map(({ key, time }) => ({ key, dueAt: new Date(time).toISOString() })));
  return true;
}

/** Framework-owned due-work keys. */
export const frameworkDueWork = {
  outbox: "framework:outbox",
  /** Local webhook retries and native webhook recovery for one organization. */
  webhooks: (organizationId: string) => `framework:webhooks:${organizationId}`,
  /** A local-only no-op, used to observe alarms under wrangler dev. */
  probe: (id: string) => `framework:probe:${id}`,
} as const;
