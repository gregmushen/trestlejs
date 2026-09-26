import type { Logger } from "@__TRESTLE_PROJECT_NAME__/context";
import { PostgresEventInbox, PostgresOutboxStore, type CommittedEventStore } from "@__TRESTLE_PROJECT_NAME__/db";
import { CloudflareQueuePublisher, PermanentEventError, safeErrorCategory, type EventEnvelope, type EventInboxStore, type QueuePublisher } from "@__TRESTLE_PROJECT_NAME__/events";

import { handleEventWithInbox, type EventConsumerRegistry, type PostCommitEffect } from "./async-runtime.js";
import type { WorkerEnvironment } from "./worker-environment.js";

/**
 * Where committed events and scheduled work execute. The transactional outbox
 * stays the source of truth for every runtime: the dispatcher hands each
 * committed event to the selected runtime under its stable event ID, and the
 * runtime runs `consumeCommittedEvent` inside its own retried step.
 */
export type JobRuntimeName = "cloudflare" | "trigger" | "inngest";
export const jobRuntimeNames = ["cloudflare", "trigger", "inngest"] as const;

export type JobRuntimeAdapter = Readonly<{
  name: JobRuntimeName;
  /**
   * Accepts committed events. Sending the same event ID again must never run
   * it twice (a lost acknowledgement is resent), so external runtimes key
   * their idempotency on the event ID. Undefined while the runtime is not
   * configured: rows stay pending and the sweep retries.
   */
  publisher(environment: WorkerEnvironment): QueuePublisher | undefined;
  /** For `trestle status`, `doctor`, and the operational health route. Never includes secrets. */
  describe(environment: WorkerEnvironment): Readonly<{ configured: boolean; detail: string }>;
}>;

export const cloudflareRuntime: JobRuntimeAdapter = {
  name: "cloudflare",
  publisher: (environment) => environment.TRESTLE_EVENTS ? new CloudflareQueuePublisher(environment.TRESTLE_EVENTS) : undefined,
  describe: (environment) => environment.TRESTLE_EVENTS
    ? { configured: true, detail: environment.TRESTLE_WORKFLOWS_ENABLED === "true" ? "Cloudflare Queues into Workflows" : "Cloudflare Queues" }
    : { configured: false, detail: "no TRESTLE_EVENTS Queue binding; committed events wait in the outbox" },
};

const adapters = new Map<JobRuntimeName, JobRuntimeAdapter>([["cloudflare", cloudflareRuntime]]);

/** Adapters for optional runtimes register themselves when their package is installed. */
export function registerJobRuntime(adapter: JobRuntimeAdapter): void {
  adapters.set(adapter.name, adapter);
}

/** The runtime selected by TRESTLE_JOB_RUNTIME (default `cloudflare`). An unknown or unregistered name fails closed. */
export function jobRuntime(environment: WorkerEnvironment): JobRuntimeAdapter {
  const name = (environment.TRESTLE_JOB_RUNTIME ?? "cloudflare") as JobRuntimeName;
  if (!jobRuntimeNames.includes(name)) throw new Error(`Unknown job runtime ${String(environment.TRESTLE_JOB_RUNTIME)}`);
  const adapter = adapters.get(name);
  if (!adapter) throw new Error(`Job runtime ${name} is selected but its adapter is not installed`);
  return adapter;
}

/**
 * One execution of a committed event's step, on any runtime. Every execution,
 * including retries and resumed runs, reloads provenance, rechecks the replay
 * window and current entitlements, and claims the inbox; nothing is memoized
 * across executions. A `PermanentEventError` becomes the runtime's own
 * non-retryable error (`permanent`); every other failure stays retryable.
 */
export async function consumeCommittedEvent<Environment, Data = unknown>(input: {
  registry: EventConsumerRegistry<Environment, Data>;
  inbox: EventInboxStore;
  outbox: CommittedEventStore;
  envelope: EventEnvelope;
  environment: Environment;
  runId: string;
  runtime: JobRuntimeName;
  log: Logger;
  permanent: (reason: string) => Error;
  postCommit?: PostCommitEffect<Environment>;
  /** Log event prefix and retry message; the Cloudflare Workflow keeps its established names. */
  logPrefix?: string;
  retryMessage?: string;
  fields?: Record<string, unknown>;
}): Promise<void> {
  const prefix = input.logPrefix ?? "job";
  const fields = input.fields ?? { runId: input.runId, runtime: input.runtime, eventName: input.envelope.name };
  try {
    await handleEventWithInbox(input.registry, input.inbox, input.outbox, input.envelope, input.environment, input.postCommit);
    input.log.info(`${prefix}.event.completed`, fields);
  } catch (error) {
    if (error instanceof PermanentEventError) {
      input.log.warn(`${prefix}.event.rejected`, { ...fields, reason: error.reason });
      // Like a Queue rejection, a permanent failure dead-letters the committed event: visible and redrivable, never settled.
      await input.outbox.reject?.(input.envelope.id, error.reason).catch(() => undefined);
      throw input.permanent(`Event rejected: ${error.reason}`);
    }
    input.log.warn(`${prefix}.event.retrying`, { ...fields, errorCategory: safeErrorCategory(error) });
    throw new Error(input.retryMessage ?? "Job handler failed");
  }
}

/**
 * The body of an external runtime's run for one committed event (trigger.dev
 * task, Inngest step): load it from the outbox by ID, then run the
 * runtime-neutral step. An unknown ID is a permanent rejection.
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
