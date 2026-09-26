import { NonRetriableError, type Inngest } from "inngest";

import { createLogger, loggerSecretsFromEnvironment } from "@__TRESTLE_PROJECT_NAME__/context";
import { PostgresOutboxStore } from "@__TRESTLE_PROJECT_NAME__/db";

import type { EventConsumerRegistry } from "../async-runtime.js";
import { inngestEventName } from "../job-runtime-inngest.js";
import { executeCommittedEventById } from "../job-runtime.js";
import type { ScheduledJobRegistry } from "../scheduled-jobs.js";
import { scheduledJobName } from "../scheduled-jobs.js";
import { projectWebhookForEvent } from "../webhook-runtime.js";
import type { WorkerEnvironment } from "../worker-environment.js";

/**
 * The Inngest functions for this Worker. `trestle-event` runs one committed
 * event inside a step: every attempt reloads and re-verifies it and rechecks
 * entitlements, because a step's result is memoized only after it succeeds.
 * `trestle-due-work` runs due scheduled jobs every minute.
 */
export function createInngestFunctions(inngest: Inngest, environment: WorkerEnvironment, registries: { eventConsumers: EventConsumerRegistry<WorkerEnvironment, unknown>; scheduledJobs: ScheduledJobRegistry<WorkerEnvironment, unknown> }) {
  const event = inngest.createFunction(
    { id: "trestle-event", retries: 5, triggers: [{ event: inngestEventName }] },
    async ({ event: received, step, runId }) => {
      await step.run("consume-event-v1", async () => {
        const log = createLogger({ runId }, undefined, { secretValues: loggerSecretsFromEnvironment(environment) });
        await executeCommittedEventById({
          eventId: String((received.data as { eventId?: unknown }).eventId ?? ""), connectionString: environment.DATABASE_URL, registry: registries.eventConsumers, environment, runId, runtime: "inngest", log,
          permanent: (message) => new NonRetriableError(message),
          postCommit: async (message, current, committed, context) => {
            const outbox = new PostgresOutboxStore(environment.DATABASE_URL, { assumeApplicationRole: true });
            try { await projectWebhookForEvent({ envelope: message, environment: current, outbox, ...(committed ? { committed } : {}), ...(context ? { now: () => context.clock.now() } : {}) }); }
            finally { await outbox.close(); }
          },
        });
      });
    },
  );
  const dueWork = inngest.createFunction(
    { id: "trestle-due-work", triggers: [{ cron: "* * * * *" }] },
    async () => {
      if (registries.scheduledJobs.names().length === 0) return { ran: 0 };
      let ran = 0;
      for (const item of await registries.scheduledJobs.due(environment)) {
        const name = scheduledJobName(item.key);
        const dueAt = new Date(item.dueAt);
        if (name === null || dueAt > new Date()) continue;
        await registries.scheduledJobs.run(name, dueAt, environment);
        ran += 1;
      }
      return { ran };
    },
  );
  return [event, dueWork];
}
