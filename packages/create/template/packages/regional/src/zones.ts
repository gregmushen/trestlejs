/** Wall-clock fields of an instant in a zone. */
export type ZonedFields = Readonly<{ year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }>;

const fieldFormatters = new Map<string, Intl.DateTimeFormat>();
function fieldFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = fieldFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" });
    fieldFormatters.set(timeZone, formatter);
  }
  return formatter;
}

const weekdays: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedFields(instant: Date, timeZone: string): ZonedFields {
  const parts = Object.fromEntries(fieldFormatter(timeZone).formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
    weekday: weekdays[parts.weekday ?? ""] ?? 0,
  };
}

/** The zone's UTC offset at an instant, in minutes east of UTC. */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const fields = zonedFields(instant, timeZone);
  const asUtc = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** "UTC−07:00" (typographic minus), informational only. */
export function formatOffset(instant: Date, timeZone: string): string {
  const minutes = offsetMinutes(instant, timeZone);
  const sign = minutes < 0 ? "−" : "+";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

/**
 * Converts a wall-clock time in a zone to an instant. A time that falls in a
 * DST gap moves forward by the gap; an ambiguous time in an overlap resolves
 * to its first (earlier) occurrence.
 */
export function zonedTimeToInstant(fields: Readonly<{ year: number; month: number; day: number; hour: number; minute: number }>, timeZone: string): Date {
  const wall = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
  const before = offsetMinutes(new Date(wall - 86_400_000), timeZone);
  const after = offsetMinutes(new Date(wall + 86_400_000), timeZone);
  // Try the earlier offset first so overlaps pick the first occurrence.
  for (const offset of before >= after ? [before, after] : [after, before]) {
    const candidate = new Date(wall - offset * 60_000);
    if (offsetMinutes(candidate, timeZone) === offset) return candidate;
  }
  // Gap: the wall time does not exist; shift forward by the transition size.
  return new Date(wall - Math.min(before, after) * 60_000);
}
