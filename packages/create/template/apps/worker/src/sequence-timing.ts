/**
 * Pure timing for email sequences: wait durations, the recipient's time zone,
 * and quiet hours. Every engine stores the computed wake time with the run, so
 * a retried or resumed step sleeps until the same instant.
 */

/** A parsed `wait`: calendar days (kept at the same local time in the recipient's zone) or an exact span. */
export type SequenceWait = Readonly<{ days: number } | { ms: number }>;
/** Local wall-clock times, `HH:MM`; the window may cross midnight (the default 21:00–08:00 does). */
export type QuietHours = Readonly<{ start: string; end: string }>;

export const defaultQuietHours: QuietHours = { start: "21:00", end: "08:00" };

const units = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** `30s`, `15m`, `12h`, `3d`, `2w`. Days and weeks are calendar days in the recipient's time zone. */
export function parseSequenceWait(value: string): SequenceWait {
  const match = /^([1-9][0-9]{0,4})([smhdw])$/u.exec(value);
  if (!match) throw new Error(`Invalid sequence wait "${value}": use a whole number and one of s, m, h, d, w (for example 3d)`);
  const amount = Number(match[1]);
  const unit = match[2] as "s" | "m" | "h" | "d" | "w";
  if (unit === "d" || unit === "w") return { days: unit === "w" ? amount * 7 : amount };
  return { ms: amount * units[unit] };
}

/** The longest a wait can take, in days, before quiet hours: for checking a sequence fits its validity window. */
export function sequenceWaitDays(wait: SequenceWait): number {
  return "days" in wait ? wait.days + 1 / 24 : wait.ms / 86_400_000;
}

function minutes(value: string): number {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/u.exec(value);
  if (!match) throw new Error(`Invalid quiet hours time "${value}": use HH:MM`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function assertQuietHours(quietHours: QuietHours): void {
  if (minutes(quietHours.start) === minutes(quietHours.end)) throw new Error("Quiet hours must start and end at different times");
}

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function validTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone }); return true; } catch { return false; }
}

type WallTime = { year: number; month: number; day: number; hour: number; minute: number; second: number };
const formatters = new Map<string, Intl.DateTimeFormat>();

function wallTime(instant: Date, timeZone: string): WallTime {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

const asUtc = (wall: WallTime) => Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
const offset = (instant: number, timeZone: string) => asUtc(wallTime(new Date(instant), timeZone)) - Math.floor(instant / 1_000) * 1_000;

/**
 * The instant a local wall-clock time names in `timeZone`. A time that occurs
 * twice (the hour clocks fall back) resolves to the first occurrence; a time
 * that does not exist (the hour clocks spring forward) moves forward by the gap.
 */
export function zonedInstant(wall: WallTime, timeZone: string): Date {
  const guess = asUtc(wall);
  const candidates = [...new Set([guess - offset(guess, timeZone), guess - offset(guess - offset(guess, timeZone), timeZone)])];
  const exact = candidates.filter((candidate) => asUtc(wallTime(new Date(candidate), timeZone)) === guess);
  return new Date(exact.length ? Math.min(...exact) : Math.max(...candidates));
}

/** When a wait that starts at `from` ends: calendar days keep the local time of day in the recipient's zone (UTC when unknown). */
export function sequenceWaitEnd(from: Date, wait: SequenceWait, timeZone: string | null): Date {
  if ("ms" in wait) return new Date(from.getTime() + wait.ms);
  const zone = validTimeZone(timeZone) ? timeZone : "UTC";
  const local = wallTime(from, zone);
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day + wait.days));
  return zonedInstant({ ...local, year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }, zone);
}

/**
 * The first instant at or after `at` outside quiet hours in the recipient's
 * zone (UTC when unknown). A send due inside quiet hours moves to the window's
 * end that day, or the next day for the part of the window before midnight.
 */
export function nextAllowedSendTime(at: Date, timeZone: string | null, quietHours: QuietHours | null): Date {
  if (!quietHours) return at;
  const zone = validTimeZone(timeZone) ? timeZone : "UTC";
  const start = minutes(quietHours.start);
  const end = minutes(quietHours.end);
  const local = wallTime(at, zone);
  const now = local.hour * 60 + local.minute;
  const quiet = start < end ? now >= start && now < end : now >= start || now < end;
  if (!quiet) return at;
  const nextDay = start > end && now >= start ? 1 : 0;
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day + nextDay));
  const allowed = zonedInstant({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: Math.floor(end / 60), minute: end % 60, second: 0 }, zone);
  return allowed > at ? allowed : at;
}
