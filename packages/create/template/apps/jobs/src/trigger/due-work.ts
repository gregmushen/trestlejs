import { schedules } from "@trigger.dev/sdk";

import { scheduledJobs } from "../../../worker/src/jobs.js";
import { scheduledJobName } from "../../../worker/src/scheduled-jobs.js";
import { jobEnvironment } from "../environment.js";

/**
 * Scheduled jobs (apps/worker/src/jobs.ts) under trigger.dev: every minute,
 * run each job whose next due time has passed. Each run keeps the registry's
 * lease, so overlapping schedules never run a job twice.
 */
export const trestleDueWork = schedules.task({
  id: "trestle-due-work",
  cron: "* * * * *",
  run: async () => {
    if (scheduledJobs.names().length === 0) return { ran: 0 };
    const environment = jobEnvironment();
    const now = new Date();
    let ran = 0;
    for (const item of await scheduledJobs.due(environment)) {
      const name = scheduledJobName(item.key);
      const dueAt = new Date(item.dueAt);
      if (name === null || dueAt > now) continue;
      await scheduledJobs.run(name, dueAt, environment);
      ran += 1;
    }
    return { ran };
  },
});
