import { AbortTaskRunError, task, wait } from "@trigger.dev/sdk";

import { conformanceRegistry, conformanceSequences } from "../../../worker/src/job-conformance.js";
import { cancelTriggerRun, executeCommittedEventById, triggerSequenceRun } from "../../../worker/src/job-runtime-trigger.js";
import { driveSequenceRun, type SequenceEngine } from "../../../worker/src/sequence-runtime.js";
import { conformanceVersion } from "./version.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } } as never;
const sequenceTask = "trestle-conformance-sequence";

/** Sequence runs start and cancel through the same REST calls the Worker makes, with this dev environment's key. */
const sequenceEngine: SequenceEngine<unknown> = {
  name: "trigger",
  start: async (_environment, run) => ({ engineRunId: (await triggerSequenceRun({ apiUrl: process.env.TRIGGER_API_URL ?? "https://api.trigger.dev", secretKey: process.env.TRIGGER_SECRET_KEY!, taskId: sequenceTask, ...run })).runId }),
  cancel: async (_environment, run) => { if (run.engineRunId) await cancelTriggerRun({ apiUrl: process.env.TRIGGER_API_URL ?? "https://api.trigger.dev", secretKey: process.env.TRIGGER_SECRET_KEY!, runId: run.engineRunId }); },
};

/** The runtime conformance suite's task (loaded only with TRESTLE_JOB_CONFORMANCE=1). */
export const trestleConformanceEvent = task({
  id: "trestle-conformance-event",
  retry: { maxAttempts: 6, factor: 1.5, minTimeoutInMs: 200, maxTimeoutInMs: 1_000, randomize: false },
  run: async (payload: { eventId: string }, { ctx }) => {
    const connectionString = process.env.TRESTLE_CONFORMANCE_DATABASE_URL!;
    await executeCommittedEventById({
      eventId: payload.eventId, connectionString, registry: conformanceRegistry(connectionString, conformanceVersion, sequenceEngine), environment: {}, runId: ctx.run.id, runtime: "trigger", log: quiet,
      permanent: (message) => new AbortTaskRunError(message), assumeApplicationRole: false,
    });
  },
});

/** The conformance sequence runs, as `trestle-sequence` runs the application's. */
export const trestleConformanceSequence = task({
  id: sequenceTask,
  retry: { maxAttempts: 6, factor: 1.5, minTimeoutInMs: 200, maxTimeoutInMs: 1_000, randomize: false },
  run: async (payload: { runId: string; triggerEventId: string }) => {
    await driveSequenceRun({
      registry: conformanceSequences(process.env.TRESTLE_CONFORMANCE_DATABASE_URL!, sequenceEngine), environment: {}, run: payload,
      step: async (_name, execute) => await execute(),
      sleepUntil: async (_name, at) => { if (at.getTime() > Date.now()) await wait.until({ date: at }); },
      permanent: (message) => new AbortTaskRunError(message),
    });
  },
});
