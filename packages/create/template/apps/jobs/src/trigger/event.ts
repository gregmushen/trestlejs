import { AbortTaskRunError, task } from "@trigger.dev/sdk";

import { createLogger, loggerSecretsFromEnvironment } from "@__TRESTLE_PROJECT_NAME__/context";
import { eventConsumers } from "../../../worker/src/index.js";
import { executeCommittedEventById, triggerEventTask } from "../../../worker/src/job-runtime-trigger.js";
import { projectWebhookForEvent } from "../../../worker/src/webhook-runtime.js";
import { PostgresOutboxStore } from "@__TRESTLE_PROJECT_NAME__/db";
import { jobEnvironment } from "../environment.js";

/**
 * One committed event. The payload is only its ID; the committed envelope is
 * loaded from the outbox, then verified, authorized, and entitlement-checked
 * again on every attempt. A permanent rejection ends the run without retries.
 */
export const trestleEvent = task({
  id: triggerEventTask,
  run: async (payload: { eventId: string }, { ctx }) => {
    const environment = jobEnvironment();
    const log = createLogger({ runId: ctx.run.id, attempt: ctx.attempt.number }, undefined, { secretValues: loggerSecretsFromEnvironment(environment) });
    await executeCommittedEventById({
      eventId: payload.eventId, connectionString: environment.DATABASE_URL, registry: eventConsumers, environment, runId: ctx.run.id, runtime: "trigger", log,
      permanent: (message) => new AbortTaskRunError(message),
      postCommit: async (message, current, committed, context) => {
        const outbox = new PostgresOutboxStore(environment.DATABASE_URL, { assumeApplicationRole: true });
        try { await projectWebhookForEvent({ envelope: message, environment: current, outbox, ...(committed ? { committed } : {}), ...(context ? { now: () => context.clock.now() } : {}) }); }
        finally { await outbox.close(); }
      },
    });
  },
});
