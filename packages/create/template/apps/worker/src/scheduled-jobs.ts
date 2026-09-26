import { createLogger, loggerSecretsFromEnvironment, type Logger } from "@__TRESTLE_PROJECT_NAME__/context";
import { assertScheduledJobName, type ScheduledJobStore } from "@__TRESTLE_PROJECT_NAME__/db";
import { safeErrorCategory } from "@__TRESTLE_PROJECT_NAME__/events";

import { eventStatementCount, type EventPublisher } from "./events.js";
import { defaultRetryDelayMs, frameworkDueWork, scheduleDueWork, type DueWorkItem, type DueWorkSchedulerBinding } from "./scheduler.js";

/** Bindings a job may require. A job whose capability is not bound is skipped, never run without it. */
export type ScheduledJobCapability = "queues" | "r2" | "workflows";

export type ScheduledJobEnvironment = {
  DATABASE_URL: string;
  TRESTLE_SCHEDULER?: DueWorkSchedulerBinding;
  TRESTLE_EVENTS?: unknown;
  TRESTLE_ARTIFACTS?: unknown;
  TRESTLE_WORKFLOW?: unknown;
  TRESTLE_WORKFLOWS_ENABLED?: string;
};

export type ScheduledJobContext<Environment, Data> = Readonly<{
  name: string;
  /** The due slot this run serves. Derive item idempotency keys from it. */
  dueAt: Date;
  /** The most items one run should process; return `{ more: true }` to continue immediately. */
  limit: number;
  /** Aborted shortly before the lease expires: stop taking new items. */
  signal: AbortSignal;
  deadline: Date;
  lease: Readonly<{ token: string; held(): Promise<boolean> }>;
  /**
   * Tenant-scoped data (forced RLS) and a transactional event publisher for one
   * organization. Execute `events.statement(...)` inside a `data.transaction`
   * with the change it describes; events are dispatched after the run through
   * the committed-event path, never sent to the Queue directly. Opened once per
   * organization and closed when the run ends.
   */
  tenant(organizationId: string): Readonly<{ data: Data; events: EventPublisher }>;
  environment: Environment;
  log: Logger;
  clock: { now(): Date };
}>;

export type ScheduledJobResult = void | { more?: boolean };

export type ScheduledJobDefinition<Environment, Data> = Readonly<{
  /**
   * When the job is next due, or null when nothing is pending. Called after
   * every run and by the safety sweep, so keep it to one indexed query or pure
   * arithmetic (see `every()` and `dailyAt()`).
   */
  next(context: { now: Date; environment: Environment; log: Logger }): Promise<Date | null> | Date | null;
  /** A bounded run. It must be safe to repeat: a crash after partial work runs the same slot again. */
  run(context: ScheduledJobContext<Environment, Data>): Promise<ScheduledJobResult>;
  requires?: { capability: ScheduledJobCapability };
  /** How long one run may hold the job (default 120 s, at most 900 s). */
  leaseMs?: number;
  /** Items per run (default 50). */
  limit?: number;
}>;

export type ScheduledJobRunResult = {
  outcome: "ran" | "busy" | "completed" | "skipped" | "failed" | "lease_lost" | "unknown";
  next: Date | null;
  wake: DueWorkItem[];
};

export type ScheduledJobDependencies<Environment, Data> = {
  store: (environment: Environment) => { store: ScheduledJobStore; close(): Promise<void> };
  tenantData?: (environment: Environment, organizationId: string) => Data;
  closeTenantData?: (data: Data) => Promise<void>;
  events?: (organizationId: string, correlationId: string, clock: { now(): Date }) => EventPublisher;
  clock?: { now(): Date };
  logger?: (fields: Record<string, unknown>, environment: Environment) => Logger;
};

const jobKeyPrefix = "job:";
/** A job whose next time is already due is re-run no sooner than this, so a job that never advances cannot spin. */
const minimumRerunMs = 1_000;

export function capabilityAvailable(environment: ScheduledJobEnvironment, capability: ScheduledJobCapability): boolean {
  if (capability === "queues") return Boolean(environment.TRESTLE_EVENTS);
  if (capability === "r2") return Boolean(environment.TRESTLE_ARTIFACTS);
  return environment.TRESTLE_WORKFLOWS_ENABLED === "true" && Boolean(environment.TRESTLE_WORKFLOW);
}

export function scheduledJobKey(name: string): string {
  return `${jobKeyPrefix}${name}`;
}

export function scheduledJobName(key: string): string | null {
  return key.startsWith(jobKeyPrefix) ? key.slice(jobKeyPrefix.length) : null;
}

function isLeaseLost(error: unknown): boolean {
  return error instanceof Error && error.name === "ScheduledJobLeaseLostError";
}

/**
 * Application due work. Register named jobs instead of adding a cron: the
 * scheduler runs each job when `next()` says it is due, under a PostgreSQL
 * lease so overlapping runs never process the same slot twice.
 */
export class ScheduledJobRegistry<Environment extends ScheduledJobEnvironment = ScheduledJobEnvironment, Data = unknown> {
  private readonly jobs = new Map<string, ScheduledJobDefinition<Environment, Data>>();
  private readonly clock: { now(): Date };
  constructor(private readonly dependencies: ScheduledJobDependencies<Environment, Data>) {
    this.clock = dependencies.clock ?? { now: () => new Date() };
  }

  register(name: string, definition: ScheduledJobDefinition<Environment, Data>): this {
    assertScheduledJobName(name);
    if (this.jobs.has(name)) throw new Error(`Scheduled job ${name} is already registered`);
    if (typeof definition?.next !== "function" || typeof definition.run !== "function") throw new Error(`Scheduled job ${name} needs next() and run() functions`);
    const leaseMs = definition.leaseMs ?? 120_000;
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 900_000) throw new Error(`Scheduled job ${name} leaseMs must be from 1000 to 900000`);
    const limit = definition.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error(`Scheduled job ${name} limit must be from 1 to 10000`);
    if (definition.requires && !["queues", "r2", "workflows"].includes(definition.requires.capability)) throw new Error(`Scheduled job ${name} requires an unknown capability`);
    this.jobs.set(name, definition);
    return this;
  }

  names(): string[] { return [...this.jobs.keys()]; }
  has(name: string): boolean { return this.jobs.has(name); }

  /** Record a job's due time with the scheduler, after committing the work that makes it due. */
  async notify(environment: Environment, name: string, dueAt: Date): Promise<boolean> {
    if (!this.jobs.has(name)) throw new Error(`Scheduled job ${name} is not registered`);
    return await scheduleDueWork(environment.TRESTLE_SCHEDULER, [{ key: scheduledJobKey(name), dueAt }]);
  }

  /** Every enabled job's next due time, for the safety sweep. A failing `next()` is logged and skipped. */
  async due(environment: Environment, now = this.clock.now()): Promise<DueWorkItem[]> {
    const items: DueWorkItem[] = [];
    for (const [name, job] of this.jobs) {
      if (job.requires && !capabilityAvailable(environment, job.requires.capability)) continue;
      const log = this.logger({ job: name }, environment);
      try {
        const next = await job.next({ now, environment, log });
        if (next) items.push({ key: scheduledJobKey(name), dueAt: this.floor(next, now) });
      } catch (error) {
        log.warn("scheduler.job.next_failed", { job: name, errorCategory: safeErrorCategory(error) });
      }
    }
    return items;
  }

  /** Run one due slot of a job. Failures are recorded and returned with a retry time, not thrown. */
  async run(name: string, dueAt: Date, environment: Environment): Promise<ScheduledJobRunResult> {
    const job = this.jobs.get(name);
    const log = this.logger({ job: name }, environment);
    if (!job) {
      log.warn("scheduler.job.unknown", { job: name });
      return { outcome: "unknown", next: null, wake: [] };
    }
    if (job.requires && !capabilityAvailable(environment, job.requires.capability)) {
      log.warn("scheduler.job.skipped", { job: name, reason: "capability_unavailable", capability: job.requires.capability });
      return { outcome: "skipped", next: null, wake: [] };
    }
    const leaseMs = job.leaseMs ?? 120_000;
    const { store, close } = this.dependencies.store(environment);
    try {
      const acquisition = await store.acquire(name, dueAt, leaseMs);
      if (acquisition.state === "busy") return { outcome: "busy", next: acquisition.leasedUntil, wake: [] };
      if (acquisition.state === "completed") return { outcome: "completed", next: await this.nextAfter(job, environment, log, acquisition.completedDueAt), wake: [] };
      const { token } = acquisition;
      const started = this.clock.now();
      const deadline = new Date(started.getTime() + leaseMs - Math.min(10_000, Math.floor(leaseMs / 5)));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(0, deadline.getTime() - started.getTime()));
      const tenants = new Map<string, { data: Data; events: EventPublisher }>();
      const correlationId = crypto.randomUUID();
      const context: ScheduledJobContext<Environment, Data> = Object.freeze({
        name, dueAt, limit: job.limit ?? 50, signal: controller.signal, deadline,
        lease: Object.freeze({ token, held: async () => await store.holds(name, token) }),
        tenant: (organizationId: string) => {
          const existing = tenants.get(organizationId);
          if (existing) return existing;
          if (!this.dependencies.tenantData || !this.dependencies.events) throw new Error(`Scheduled job ${name} has no tenant data factory`);
          const opened = Object.freeze({ data: this.dependencies.tenantData(environment, organizationId), events: this.dependencies.events(organizationId, correlationId, this.clock) });
          tenants.set(organizationId, opened);
          return opened;
        },
        environment, log: log.child({ correlationId }), clock: this.clock,
      });
      let result: ScheduledJobResult = undefined;
      let failure: unknown;
      try { result = await job.run(context); }
      catch (error) { failure = error; }
      finally {
        clearTimeout(timer);
        for (const opened of tenants.values()) {
          try { await this.dependencies.closeTenantData?.(opened.data); }
          catch { log.warn("scheduler.job.tenant_data.close_failed", { job: name }); }
        }
      }
      const emitted = [...tenants.values()].some((opened) => eventStatementCount(opened.events) > 0);
      const wake: DueWorkItem[] = emitted ? [{ key: frameworkDueWork.outbox, dueAt: this.clock.now() }] : [];
      if (failure !== undefined) {
        let failures = 1;
        try { failures = await store.fail(name, token, failure); }
        catch (error) { if (!isLeaseLost(error)) throw error; }
        log.error("scheduler.job.failed", { job: name, errorCategory: safeErrorCategory(failure), failures });
        return { outcome: "failed", next: new Date(this.clock.now().getTime() + defaultRetryDelayMs(failures)), wake };
      }
      const more = Boolean(result && result.more);
      try { await store.complete(name, token, dueAt, { more }); }
      catch (error) {
        if (!isLeaseLost(error)) throw error;
        // Another run may have taken over; let the scheduler try again and the lease decide.
        log.warn("scheduler.job.lease_lost", { job: name });
        return { outcome: "lease_lost", next: this.clock.now(), wake };
      }
      log.info("scheduler.job.completed", { job: name, more, durationMs: this.clock.now().getTime() - started.getTime() });
      return { outcome: "ran", next: more ? this.clock.now() : await this.nextAfter(job, environment, log, dueAt), wake };
    } finally {
      await close();
    }
  }

  private async nextAfter(job: ScheduledJobDefinition<Environment, Data>, environment: Environment, log: Logger, completedDueAt: Date): Promise<Date | null> {
    const now = this.clock.now();
    const next = await job.next({ now, environment, log });
    if (!next) return null;
    return this.floor(new Date(Math.max(next.getTime(), completedDueAt.getTime() + 1)), now);
  }

  private floor(next: Date, now: Date): Date {
    if (!Number.isFinite(next.getTime())) throw new Error("A scheduled job's next() returned an invalid date");
    return next.getTime() < now.getTime() + minimumRerunMs ? new Date(now.getTime() + minimumRerunMs) : next;
  }

  private logger(fields: Record<string, unknown>, environment: Environment): Logger {
    return this.dependencies.logger?.(fields, environment) ?? createLogger(fields, undefined, { secretValues: loggerSecretsFromEnvironment(environment as object) });
  }
}
