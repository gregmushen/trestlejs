import { AbortTaskRunError, task } from "@trigger.dev/sdk";

import { conformanceRegistry } from "../../../worker/src/job-conformance.js";
import { executeCommittedEventById } from "../../../worker/src/job-runtime-trigger.js";
import { conformanceVersion } from "./version.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } } as never;

/** The runtime conformance suite's task (loaded only with TRESTLE_JOB_CONFORMANCE=1). */
export const trestleConformanceEvent = task({
  id: "trestle-conformance-event",
  retry: { maxAttempts: 6, factor: 1.5, minTimeoutInMs: 200, maxTimeoutInMs: 1_000, randomize: false },
  run: async (payload: { eventId: string }, { ctx }) => {
    const connectionString = process.env.TRESTLE_CONFORMANCE_DATABASE_URL!;
    await executeCommittedEventById({
      eventId: payload.eventId, connectionString, registry: conformanceRegistry(connectionString, conformanceVersion), environment: {}, runId: ctx.run.id, runtime: "trigger", log: quiet,
      permanent: (message) => new AbortTaskRunError(message), assumeApplicationRole: false,
    });
  },
});
