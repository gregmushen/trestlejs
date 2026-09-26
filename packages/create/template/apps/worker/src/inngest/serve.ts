import { Inngest } from "inngest";
import { serve } from "inngest/hono";
import { Hono } from "hono";

import { eventConsumers } from "../index.js";
import { scheduledJobs } from "../jobs.js";
import type { WorkerEnvironment } from "../worker-environment.js";
import { createInngestFunctions } from "./functions.js";

/**
 * The signed endpoint Inngest calls to run this Worker's functions
 * (jobs.runtime: inngest). The SDK verifies INNGEST_SIGNING_KEY on every
 * request; the Dev Server is accepted only with INNGEST_DEV=1 locally.
 */
export const inngestRoutes = new Hono<{ Bindings: WorkerEnvironment }>();
inngestRoutes.on(["GET", "POST", "PUT"], "/api/jobs/inngest", async (context) => {
  const environment = context.env as WorkerEnvironment & { INNGEST_SIGNING_KEY?: string; INNGEST_BASE_URL?: string; INNGEST_DEV?: string };
  if (environment.INNGEST_DEV === "1" && environment.APP_ENV && environment.APP_ENV !== "local") return context.json({ error: "not_found" }, 404);
  const inngest = new Inngest({
    id: "__TRESTLE_PROJECT_NAME__",
    ...(environment.INNGEST_DEV === "1" ? { isDev: true } : {}),
    ...(environment.INNGEST_BASE_URL ? { baseUrl: environment.INNGEST_BASE_URL } : {}),
  });
  return await serve({ client: inngest, functions: createInngestFunctions(inngest, environment, { eventConsumers: eventConsumers as never, scheduledJobs: scheduledJobs as never }), ...(environment.INNGEST_SIGNING_KEY ? { signingKey: environment.INNGEST_SIGNING_KEY } : {}) })(context);
});
