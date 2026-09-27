import { AbortTaskRunError, task, wait } from "@trigger.dev/sdk";

import { createLogger, loggerSecretsFromEnvironment } from "@__TRESTLE_PROJECT_NAME__/context";
import { emailSequences } from "../../../worker/src/email-sequences.js";
import { triggerSequenceTask } from "../../../worker/src/job-runtime-trigger.js";
import { driveSequenceRun } from "../../../worker/src/sequence-runtime.js";
import { jobEnvironment } from "../environment.js";

/**
 * One email sequence run. The payload is only the run and trigger event IDs;
 * each step reloads the run and re-verifies authority. Steps run directly
 * (the database fences a replayed step, so a retried attempt resumes where the
 * run is), and waits are checkpointed `wait.until`. An exit cancels the run.
 */
export const trestleSequence = task({
  id: triggerSequenceTask,
  run: async (payload: { runId: string; triggerEventId: string }, { ctx }) => {
    const environment = jobEnvironment();
    const log = createLogger({ runId: ctx.run.id, sequenceRunId: payload.runId, attempt: ctx.attempt.number }, undefined, { secretValues: loggerSecretsFromEnvironment(environment) });
    await driveSequenceRun({
      registry: emailSequences, environment, run: payload, log,
      step: async (_name, execute) => await execute(),
      sleepUntil: async (_name, at) => { if (at.getTime() > Date.now()) await wait.until({ date: at }); },
      permanent: (message) => new AbortTaskRunError(message),
    });
  },
});
