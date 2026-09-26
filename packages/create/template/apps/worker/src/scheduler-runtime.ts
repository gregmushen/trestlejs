import { createLogger, loggerSecretsFromEnvironment, type Logger } from "@__TRESTLE_PROJECT_NAME__/context";
import { createTenantDatabase, flushDueLocalWebhookDeliveries, loadCurrentWebhookSigningSecret, nextLocalWebhookRetry, PostgresOutboxStore, type Database } from "@__TRESTLE_PROJECT_NAME__/db";
import { safeErrorCategory } from "@__TRESTLE_PROJECT_NAME__/events";

import { dispatchQueuedOutbox } from "./async-runtime.js";
import { scheduledJobs } from "./jobs.js";
import { scheduledJobName } from "./scheduled-jobs.js";
import { frameworkDueWork, scheduleDueWork, type DueWorkItem, type DueWorkOutcome } from "./scheduler.js";
import { maintainNativeWebhookDeliveries } from "./webhook-recovery.js";
import type { WorkerEnvironment } from "./worker-environment.js";

/** Rows leased per dispatch batch (the outbox default) and batches per drain. */
const outboxBatchSize = 10;
const outboxBatchesPerDrain = 20;

function schedulerLog(environment: WorkerEnvironment, fields: Record<string, unknown> = {}): Logger {
  return createLogger({ environment: environment.APP_ENV ?? "local", ...fields }, undefined, { secretValues: loggerSecretsFromEnvironment(environment) });
}

/**
 * Publish due outbox rows to the Queue, bounded, and report when the outbox
 * is next due: immediately when the bound was reached, at the earliest retry
 * or expiring lease otherwise, or never when it is empty.
 */
export async function drainOutbox(environment: WorkerEnvironment, clock: { now(): Date } = { now: () => new Date() }): Promise<{ sent: number; failed: number; next: Date | null }> {
  if (!environment.TRESTLE_EVENTS) return { sent: 0, failed: 0, next: null };
  const store = new PostgresOutboxStore(environment.DATABASE_URL, { assumeApplicationRole: true });
  try {
    let sent = 0;
    let failed = 0;
    let saturated = false;
    for (let batch = 0; batch < outboxBatchesPerDrain; batch++) {
      const result = await dispatchQueuedOutbox(store, environment.TRESTLE_EVENTS);
      sent += result.sent;
      failed += result.failed;
      saturated = result.sent + result.failed >= outboxBatchSize;
      if (!saturated) break;
    }
    return { sent, failed, next: saturated ? clock.now() : await store.nextDue() };
  } finally {
    await store.close();
  }
}

/** Retry one organization's due local webhook deliveries and report its next retry. */
async function retryLocalWebhooks(environment: WorkerEnvironment, organizationId: string, clock: { now(): Date }): Promise<Date | null> {
  if (environment.WEBHOOK_DELIVERY_MODE !== "local" || (environment.APP_ENV && environment.APP_ENV !== "local")) return null;
  const masterKey = environment.WEBHOOK_SECRET_KEY;
  if (!masterKey) throw new Error("Local webhook retries require WEBHOOK_SECRET_KEY");
  let database: Database | undefined;
  const tenantDatabase = (tenant: string) => {
    if (tenant !== organizationId) throw new Error("Local webhook retry crossed its organization");
    return (database ??= createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId));
  };
  try {
    const result = await flushDueLocalWebhookDeliveries({
      organizationId, tenantDatabase, clock, scenario: { kind: "succeed" },
      signingSecretForEndpoint: async (endpointId) => await loadCurrentWebhookSigningSecret({ tenantDatabase, masterKey, environment: "local", organizationId, endpointId }),
    });
    schedulerLog(environment, { organizationId }).info("webhook.local.retry.completed", result);
    return await nextLocalWebhookRetry({ organizationId, tenantDatabase });
  } finally {
    await database?.$client.end();
  }
}

/**
 * Run one due-work key for the scheduler object. Framework keys drain the
 * outbox or retry webhooks; `job:<name>` keys run application jobs.
 */
export async function runDueWork(key: string, dueAt: Date, environment: WorkerEnvironment, clock: { now(): Date } = { now: () => new Date() }): Promise<DueWorkOutcome> {
  if (key === frameworkDueWork.outbox) {
    const result = await drainOutbox(environment, clock);
    schedulerLog(environment).info("outbox.dispatch.completed", { sent: result.sent, failed: result.failed });
    return { next: result.next };
  }
  if (key.startsWith(frameworkDueWork.probe(""))) {
    schedulerLog(environment).info("scheduler.probe.fired", { lateMs: clock.now().getTime() - dueAt.getTime() });
    return { next: null };
  }
  const webhookPrefix = frameworkDueWork.webhooks("");
  if (key.startsWith(webhookPrefix)) return { next: await retryLocalWebhooks(environment, key.slice(webhookPrefix.length), clock) };
  const job = scheduledJobName(key);
  if (job !== null) {
    const result = await scheduledJobs.run(job, dueAt, environment);
    return { next: result.next, wake: result.wake };
  }
  schedulerLog(environment).warn("scheduler.work.unknown", { key });
  return { next: null };
}

/**
 * The safety sweep (every 15 minutes). It catches what a lost notification
 * missed: it drains the outbox, repairs native webhook handoffs, and
 * re-records every due time with the scheduler. It is the only periodic
 * database access an idle project has.
 */
export async function runSafetySweep(environment: WorkerEnvironment, log: Logger): Promise<void> {
  const due: DueWorkItem[] = [];
  if (environment.TRESTLE_EVENTS) {
    const result = await drainOutbox(environment);
    log.info("outbox.dispatch.completed", { sent: result.sent, failed: result.failed });
    if (result.next) due.push({ key: frameworkDueWork.outbox, dueAt: result.next });
  }
  if (environment.WEBHOOK_DELIVERY_MODE === "native") {
    if (!environment.TRESTLE_EVENTS) throw new Error("Native webhook recovery requires the TRESTLE_EVENTS Queue binding");
    const result = await maintainNativeWebhookDeliveries({ environment, queue: environment.TRESTLE_EVENTS });
    log.info("webhook.native.recovery.completed", result);
    if (result.failed > 0) throw new Error("Native webhook recovery left incomplete work");
  }
  if (scheduledJobs.names().length > 0) {
    if (!environment.TRESTLE_SCHEDULER) {
      if (environment.APP_ENV && environment.APP_ENV !== "local") throw new Error("Registered scheduled jobs require the TRESTLE_SCHEDULER Durable Object binding");
      log.warn("scheduler.unavailable", { jobs: scheduledJobs.names().length });
    } else due.push(...await scheduledJobs.due(environment));
  }
  if (due.length > 0 && environment.TRESTLE_SCHEDULER) await scheduleDueWork(environment.TRESTLE_SCHEDULER, due);
  log.info("scheduler.sweep.completed", { recorded: environment.TRESTLE_SCHEDULER ? due.length : 0 });
}

/**
 * Dispatch on commit: after a request commits outbox rows, make the outbox due
 * now so the scheduler publishes it immediately instead of at the next sweep.
 * The outbox stays the durable source; a lost wake-up is caught by the sweep.
 */
export function wakeOutboxDispatch(context: { env: unknown; readonly executionCtx: { waitUntil(promise: Promise<unknown>): void } }): void {
  const environment = context.env as WorkerEnvironment;
  if (!environment.TRESTLE_SCHEDULER || !environment.TRESTLE_EVENTS) return;
  const wake = scheduleDueWork(environment.TRESTLE_SCHEDULER, [{ key: frameworkDueWork.outbox, dueAt: new Date() }])
    .catch((error: unknown) => { schedulerLog(environment).warn("scheduler.wake.failed", { errorCategory: safeErrorCategory(error) }); });
  try { context.executionCtx.waitUntil(wake); }
  catch { /* Outside the Workers runtime there is no execution context; the promise still settles. */ }
}
