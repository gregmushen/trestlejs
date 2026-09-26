import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Internal lease and completion state for application due-work jobs. One row
 * per registered job name; not tenant-readable or client-facing. The lease
 * keeps overlapping runs apart and `completed_due_at` makes a repeated run for
 * an already completed due slot a no-op.
 */
export const scheduledJob = pgTable("scheduled_job", {
  name: text("name").primaryKey(),
  leaseToken: text("lease_token"),
  leasedUntil: timestamp("leased_until", { withTimezone: true }),
  completedDueAt: timestamp("completed_due_at", { withTimezone: true }),
  failures: integer("failures").default(0).notNull(),
  lastError: text("last_error"),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("scheduled_job_name_check", sql`${table.name} ~ '^[a-z][a-z0-9._-]{0,99}$'`),
  check("scheduled_job_failures_check", sql`${table.failures} >= 0`),
]);
