import { eventConsumers } from "../apps/worker/src/index.js";
import { jobRuntimeNames } from "../apps/worker/src/job-runtime.js";
import { scheduledJobs } from "../apps/worker/src/jobs.js";

/** Prints the job inventory for `trestle jobs list`: event consumers and scheduled jobs, as registered in code. */
process.stdout.write(`${JSON.stringify({
  runtimes: jobRuntimeNames,
  consumers: eventConsumers.describe(),
  scheduledJobs: scheduledJobs.describe(),
})}\n`);
process.exit(0);
