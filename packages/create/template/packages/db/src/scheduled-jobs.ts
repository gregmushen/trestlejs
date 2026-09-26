import { safeErrorCategory } from "@__TRESTLE_PROJECT_NAME__/events";
import postgres from "postgres";

import { outboxApplicationConnectionString } from "./outbox.js";

export type ScheduledJobAcquisition =
  | { state: "acquired"; token: string; leasedUntil: Date }
  | { state: "busy"; leasedUntil: Date }
  | { state: "completed"; completedDueAt: Date };

/** Lease and completion state for application due-work jobs. */
export interface ScheduledJobStore {
  /** Take the job's lease for one due slot, unless another run holds it or the slot is already complete. */
  acquire(name: string, dueAt: Date, leaseMs: number): Promise<ScheduledJobAcquisition>;
  /** Whether `token` still holds an unexpired lease. */
  holds(name: string, token: string): Promise<boolean>;
  /** Release the lease. Without `more`, the due slot is recorded as complete. Throws if the lease was lost. */
  complete(name: string, token: string, dueAt: Date, options?: { more?: boolean }): Promise<void>;
  /** Release the lease after a failed run and return the consecutive failure count. Throws if the lease was lost. */
  fail(name: string, token: string, error: unknown): Promise<number>;
}

export class ScheduledJobLeaseLostError extends Error {
  constructor(name: string) { super(`Scheduled job ${name} no longer holds its lease`); this.name = "ScheduledJobLeaseLostError"; }
}

const jobNamePattern = /^[a-z][a-z0-9._-]{0,99}$/u;

export function assertScheduledJobName(name: string): void {
  if (typeof name !== "string" || !jobNamePattern.test(name)) throw new Error("Invalid scheduled job name: use lowercase letters, digits, '.', '_' or '-', starting with a letter");
}

function validDue(dueAt: Date): Date {
  if (!(dueAt instanceof Date) || !Number.isFinite(dueAt.getTime())) throw new Error("Invalid scheduled job due time");
  return dueAt;
}

type LeaseRow = { lease_token: string | null; leased_until: Date | null; completed_due_at: Date | null };

/** PostgreSQL job leases. With `assumeApplicationRole`, it runs as trestle_app, which holds only SELECT, INSERT and UPDATE on the table. */
export class PostgresScheduledJobStore implements ScheduledJobStore {
  private readonly sql;
  constructor(connectionString: string, options: { assumeApplicationRole?: boolean } = {}) {
    this.sql = postgres(options.assumeApplicationRole ? outboxApplicationConnectionString(connectionString) : connectionString, { max: 1, prepare: false, idle_timeout: 0.05 });
  }
  async close(): Promise<void> { await this.sql.end(); }

  async acquire(name: string, dueAt: Date, leaseMs: number): Promise<ScheduledJobAcquisition> {
    assertScheduledJobName(name);
    validDue(dueAt);
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 900_000) throw new Error("Scheduled job lease must be between 1 and 900000 milliseconds");
    const token = crypto.randomUUID();
    const [claimed] = await this.sql<Array<{ leased_until: Date }>>`
      insert into scheduled_job (name, lease_token, leased_until, last_started_at)
      values (${name}, ${token}, now() + (${leaseMs} * interval '1 millisecond'), now())
      on conflict (name) do update
        set lease_token = excluded.lease_token,
            leased_until = excluded.leased_until,
            last_started_at = excluded.last_started_at,
            updated_at = now()
      where (scheduled_job.leased_until is null or scheduled_job.leased_until <= now())
        and (scheduled_job.completed_due_at is null or scheduled_job.completed_due_at < ${dueAt})
      returning leased_until`;
    if (claimed) return { state: "acquired", token, leasedUntil: claimed.leased_until };
    const [existing] = await this.sql<LeaseRow[]>`select lease_token, leased_until, completed_due_at from scheduled_job where name = ${name}`;
    if (!existing) throw new Error("Scheduled job lease could not be resolved");
    if (existing.completed_due_at && existing.completed_due_at.getTime() >= dueAt.getTime()) return { state: "completed", completedDueAt: existing.completed_due_at };
    return { state: "busy", leasedUntil: existing.leased_until ?? new Date() };
  }

  async holds(name: string, token: string): Promise<boolean> {
    const [row] = await this.sql<Array<{ held: boolean }>>`select (lease_token = ${token} and leased_until > now()) as held from scheduled_job where name = ${name}`;
    return row?.held === true;
  }

  async complete(name: string, token: string, dueAt: Date, options: { more?: boolean } = {}): Promise<void> {
    validDue(dueAt);
    const more = options.more === true;
    const result = await this.sql`
      update scheduled_job
         set lease_token = null, leased_until = null, failures = 0, last_error = null,
             last_completed_at = now(), updated_at = now(),
             completed_due_at = case when ${more} then completed_due_at else greatest(coalesce(completed_due_at, ${dueAt}), ${dueAt}) end
       where name = ${name} and lease_token = ${token} and leased_until > now()`;
    if (result.count === 0) throw new ScheduledJobLeaseLostError(name);
  }

  async fail(name: string, token: string, error: unknown): Promise<number> {
    const [row] = await this.sql<Array<{ failures: number }>>`
      update scheduled_job
         set lease_token = null, leased_until = null, failures = failures + 1,
             last_error = ${safeErrorCategory(error)}, updated_at = now()
       where name = ${name} and lease_token = ${token} and leased_until > now()
       returning failures`;
    if (!row) throw new ScheduledJobLeaseLostError(name);
    return row.failures;
  }
}
