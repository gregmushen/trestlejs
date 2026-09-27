import type { EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";

import type { JobRuntimeAdapter } from "./job-runtime.js";
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

/** The trigger.dev task that runs one email sequence run (apps/jobs/src/trigger/sequence.ts). */
export const triggerSequenceTask = "trestle-sequence";

/**
 * Starts (or finds) the trigger.dev run for one sequence run. Only the run
 * and trigger event IDs leave the application; the run ID is the idempotency
 * key, so a repeated start returns the existing run.
 */
export async function triggerSequenceRun(input: { apiUrl: string; secretKey: string; taskId?: string; runId: string; triggerEventId: string; fetch?: typeof fetch }): Promise<{ runId: string }> {
  const response = await (input.fetch ?? fetch)(`${input.apiUrl.replace(/\/$/u, "")}/api/v1/tasks/${encodeURIComponent(input.taskId ?? triggerSequenceTask)}/trigger`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.secretKey}`, "content-type": "application/json" },
    body: JSON.stringify({ payload: { runId: input.runId, triggerEventId: input.triggerEventId }, options: { idempotencyKey: `trestle-sequence:${input.runId}`, idempotencyKeyTTL: triggerIdempotencyTtl } }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`trigger.dev did not accept the sequence run (HTTP ${response.status})`);
  }
  const body = await response.json() as { id?: string };
  if (typeof body.id !== "string") throw new Error("trigger.dev returned no run ID");
  return { runId: body.id };
}

/** Cancels a waiting trigger.dev run. A run that already finished is not an error. */
export async function cancelTriggerRun(input: { apiUrl: string; secretKey: string; runId: string; fetch?: typeof fetch }): Promise<void> {
  const response = await (input.fetch ?? fetch)(`${input.apiUrl.replace(/\/$/u, "")}/api/v2/runs/${encodeURIComponent(input.runId)}/cancel`, { method: "POST", headers: { authorization: `Bearer ${input.secretKey}` } });
  await response.body?.cancel();
  if (!response.ok && response.status !== 400 && response.status !== 404) throw new Error(`trigger.dev did not cancel the run (HTTP ${response.status})`);
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

export { executeCommittedEventById } from "./job-runtime.js";
