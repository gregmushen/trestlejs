import { defineSchedules, type ScheduleDefinition } from "@__TRESTLE_PROJECT_NAME__/regional";

/**
 * Application-owned recurring schedules. A schedule with
 * `zone: { kind: "organization" }` runs at its wall-clock time in each
 * organization's default time zone, so the Regional settings page lists it
 * before an organization changes zones. A schedule that names its own zone
 * never moves when an organization default changes.
 *
 * @example
 * { key: "operations.digest", name: "Daily operations digest", time: "09:00", zone: { kind: "organization" } }
 */
export const applicationSchedules: readonly ScheduleDefinition[] = defineSchedules<readonly ScheduleDefinition[]>([]);
