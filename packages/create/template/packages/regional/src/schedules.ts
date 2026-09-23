import { canonicalTimeZone } from "./identifiers.js";
import { zonedFields, zonedTimeToInstant } from "./zones.js";

/**
 * A recurring wall-clock schedule. `organization` schedules follow the
 * organization's current default zone; `zoned` schedules name their zone and
 * never move when an organization default changes.
 */
export type ScheduleZone = Readonly<{ kind: "organization" }> | Readonly<{ kind: "zoned"; timeZone: string }>;

export type ScheduleDefinition = Readonly<{
  key: string;
  name: string;
  /** "HH:MM", 24-hour wall-clock time. */
  time: string;
  /** 0 = Sunday … 6 = Saturday; omitted means every day. */
  weekdays?: readonly number[];
  zone: ScheduleZone;
}>;

const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export class ScheduleDefinitionError extends Error {
  constructor(message: string) { super(message); this.name = "ScheduleDefinitionError"; }
}

export function defineSchedules<const Schedules extends readonly ScheduleDefinition[]>(schedules: Schedules): Schedules {
  const keys = new Set<string>();
  for (const schedule of schedules) {
    if (!/^[a-z][a-z0-9_.-]*$/u.test(schedule.key) || keys.has(schedule.key)) throw new ScheduleDefinitionError(`Invalid or duplicate schedule key ${schedule.key}`);
    keys.add(schedule.key);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(schedule.time)) throw new ScheduleDefinitionError(`Schedule ${schedule.key} time must be HH:MM`);
    if (schedule.weekdays?.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new ScheduleDefinitionError(`Schedule ${schedule.key} weekdays must be 0-6`);
    if (schedule.zone.kind === "zoned" && canonicalTimeZone(schedule.zone.timeZone) !== schedule.zone.timeZone) throw new ScheduleDefinitionError(`Schedule ${schedule.key} names an unsupported time zone`);
  }
  return schedules;
}

/** The zone a schedule runs in for an organization. */
export function scheduleTimeZone(schedule: ScheduleDefinition, organizationTimeZone: string): string {
  return schedule.zone.kind === "organization" ? organizationTimeZone : schedule.zone.timeZone;
}

export function followsOrganizationTime(schedule: ScheduleDefinition): boolean {
  return schedule.zone.kind === "organization";
}

/** "Monday 08:00 organization time" or "09:00 America/New_York". */
export function describeSchedule(schedule: ScheduleDefinition): string {
  const days = schedule.weekdays?.length ? `${schedule.weekdays.map((day) => weekdayNames[day]).join(", ")} ` : "";
  return `${days}${schedule.time} ${schedule.zone.kind === "organization" ? "organization time" : schedule.zone.timeZone}`;
}

/** The first occurrence strictly after `after`, in the schedule's effective zone. */
export function nextOccurrence(schedule: ScheduleDefinition, organizationTimeZone: string, after: Date): Date {
  const timeZone = scheduleTimeZone(schedule, organizationTimeZone);
  const [hour = 0, minute = 0] = schedule.time.split(":").map(Number);
  const start = zonedFields(after, timeZone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    if (schedule.weekdays?.length && !schedule.weekdays.includes(day.getUTCDay())) continue;
    const candidate = zonedTimeToInstant({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute }, timeZone);
    if (candidate > after) return candidate;
  }
  throw new ScheduleDefinitionError(`Schedule ${schedule.key} has no occurrence within a week`);
}

export type ScheduleImpact = Readonly<{
  key: string;
  name: string;
  description: string;
  followsOrganization: boolean;
  /** Next run under the current organization zone. */
  current: string;
  /** Next run under the proposed zone; equal to `current` for zoned schedules. */
  proposed: string;
}>;

/** Shows which schedules move, and to when, if the organization zone changes. */
export function scheduleImpact(schedules: readonly ScheduleDefinition[], currentZone: string, proposedZone: string, now: Date): ScheduleImpact[] {
  return schedules.map((schedule) => ({
    key: schedule.key,
    name: schedule.name,
    description: describeSchedule(schedule),
    followsOrganization: followsOrganizationTime(schedule),
    current: nextOccurrence(schedule, currentZone, now).toISOString(),
    proposed: nextOccurrence(schedule, proposedZone, now).toISOString(),
  }));
}
