import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import type { NativeWebhookWakeup } from "@__TRESTLE_PROJECT_NAME__/db";
import type { CloudflareQueueBinding, EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";

import type { CloudflareWorkflowBinding } from "./async-runtime.js";
import type { DueWorkSchedulerBinding } from "./scheduler.js";

/** The Worker's bindings: optional capabilities are absent until provisioned. */
export type WorkerEnvironment = AuthEnvironment & {
  TRESTLE_EVENTS?: CloudflareQueueBinding<EventEnvelope | NativeWebhookWakeup>;
  TRESTLE_WORKFLOW?: CloudflareWorkflowBinding;
  TRESTLE_WORKFLOWS_ENABLED?: string;
  /** The due-time scheduler Durable Object (class TrestleScheduler). */
  TRESTLE_SCHEDULER?: DueWorkSchedulerBinding;
  /** The job runtime: cloudflare (default), trigger, or inngest. */
  TRESTLE_JOB_RUNTIME?: string;
  /** The connection backend: none (default), local, or nango. */
  TRESTLE_CONNECTION_BACKEND?: string;
};
