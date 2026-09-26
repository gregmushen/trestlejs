import { createTenantDatabase, PostgresScheduledJobStore, type Database } from "@__TRESTLE_PROJECT_NAME__/db";

import { createEventPublisher } from "./events.js";
import { ScheduledJobRegistry } from "./scheduled-jobs.js";
import type { WorkerEnvironment } from "./worker-environment.js";

/**
 * Application due work. Register a job here instead of adding a cron: the
 * scheduler runs it when `next()` says it is due, under a lease, and sleeps
 * when nothing is due. See "Scheduling" in the README.
 *
 * @example
 * import { dailyAt, every } from "./scheduler.js";
 * scheduledJobs.register("digests.daily", {
 *   next: dailyAt({ hour: 7, minute: 0, timeZone: "America/Los_Angeles" }),
 *   run: async (job) => { ... },
 * });
 */
export const scheduledJobs = new ScheduledJobRegistry<WorkerEnvironment, Database>({
  store: (environment) => {
    const store = new PostgresScheduledJobStore(environment.DATABASE_URL, { assumeApplicationRole: true });
    return { store, close: async () => { await store.close(); } };
  },
  tenantData: (environment, organizationId) => createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId),
  closeTenantData: async (data) => { await data.$client.end(); },
  events: (organizationId, correlationId, clock) => createEventPublisher({ organizationId, correlationId, clock }),
});
