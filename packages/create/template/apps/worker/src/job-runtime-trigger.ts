import type { Logger } from "@__TRESTLE_PROJECT_NAME__/context";
import { PostgresEventInbox, PostgresOutboxStore } from "@__TRESTLE_PROJECT_NAME__/db";
import { PermanentEventError, type EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";

import type { EventConsumerRegistry, PostCommitEffect } from "./async-runtime.js";
import { consumeCommittedEvent, type JobRuntimeAdapter, type JobRuntimeName } from "./job-runtime.js";
import type { WorkerEnvironment } from "./worker-environment.js";

/** The trigger.dev task that runs committed events (apps/jobs/src/trigger/event.ts). */
export const triggerEventTask = "trestle-event";
/** Idempotency keys outlive the 14-day replay window, so a resend inside it never starts a second run. */
export const triggerIdempotencyTtl = "30d";

export type TriggerEnvironment = Readonly<{ TRIGGER_SECRET_KEY?: string; TRIGGER_API_URL?: string }>;

/**
 * Starts (or finds) the run for one committed event. Only the event ID
 * leaves the application: the task loads the committed envelope from the
 * outbox, so payloads are never stored by trigger.dev. The event ID is the
 * idempotency key, so a resend after a lost acknowledgement returns the
 * existing run.
 */
export async function triggerCommittedEvent(input: { apiUrl: string; secretKey: string; taskId?: string; eventId: string; generation?: number; fetch?: typeof fetch }): Promise<{ runId: string; cached: boolean }> {
  const response = await (input.fetch ?? fetch)(`${input.apiUrl.replace(/\/$/u, "")}/api/v1/tasks/${encodeURIComponent(input.taskId ?? triggerEventTask)}/trigger`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.secretKey}`, "content-type": "application/json" },
    body: JSON.stringify({ payload: { eventId: input.eventId }, options: { idempotencyKey: `trestle-event:${input.eventId}:${input.generation ?? 0}`, idempotencyKeyTTL: triggerIdempotencyTtl } }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`trigger.dev did not accept the event (HTTP ${response.status})`);
  }
  const body = await response.json() as { id?: string; isCached?: boolean };
  if (typeof body.id !== "string") throw new Error("trigger.dev returned no run ID");
  return { runId: body.id, cached: body.isCached === true };
}

export const triggerRuntime: JobRuntimeAdapter = {
  name: "trigger",
  publisher: (environment) => {
    const trigger = environment as WorkerEnvironment & TriggerEnvironment;
    if (!trigger.TRIGGER_SECRET_KEY) return undefined;
    return { send: async (envelope: EventEnvelope, delivery?: { generation: number }) => { await triggerCommittedEvent({ apiUrl: trigger.TRIGGER_API_URL ?? "https://api.trigger.dev", secretKey: trigger.TRIGGER_SECRET_KEY!, eventId: envelope.id, generation: delivery?.generation ?? 0 }); } };
  },
  describe: (environment) => {
    const trigger = environment as WorkerEnvironment & TriggerEnvironment;
    return trigger.TRIGGER_SECRET_KEY
      ? { configured: true, detail: `trigger.dev at ${trigger.TRIGGER_API_URL ?? "https://api.trigger.dev"}` }
      : { configured: false, detail: "TRIGGER_SECRET_KEY is not set; committed events wait in the outbox" };
  },
};

/**
 * The body of a trigger.dev task run for one committed event: load it from
 * the outbox by ID, then run the runtime-neutral step. An unknown ID is a
 * permanent rejection. `permanent` is trigger.dev's AbortTaskRunError.
 */
export async function executeCommittedEventById<Environment, Data>(input: {
  eventId: string;
  connectionString: string;
  registry: EventConsumerRegistry<Environment, Data>;
  environment: Environment;
  runId: string;
  runtime: JobRuntimeName;
  log: Logger;
  permanent: (message: string) => Error;
  postCommit?: PostCommitEffect<Environment>;
  assumeApplicationRole?: boolean;
}): Promise<void> {
  const inbox = new PostgresEventInbox(input.connectionString, { assumeApplicationRole: input.assumeApplicationRole ?? true });
  const outbox = new PostgresOutboxStore(input.connectionString, { assumeApplicationRole: input.assumeApplicationRole ?? true });
  try {
    const committed = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.eventId) ? await outbox.findCommitted(input.eventId) : null;
    if (!committed) {
      input.log.warn("job.event.rejected", { runId: input.runId, runtime: input.runtime, reason: "provenance_missing" });
      throw input.permanent(`Event rejected: ${new PermanentEventError("provenance_missing").reason}`);
    }
    await consumeCommittedEvent({ registry: input.registry, inbox, outbox, envelope: committed.message, environment: input.environment, runId: input.runId, runtime: input.runtime, log: input.log, permanent: input.permanent, ...(input.postCommit ? { postCommit: input.postCommit } : {}) });
  } finally {
    await Promise.all([inbox.close(), outbox.close()]);
  }
}
