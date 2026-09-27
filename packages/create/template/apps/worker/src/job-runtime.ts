import type { Logger } from "@__TRESTLE_PROJECT_NAME__/context";
import { jobRuntimeCredentialNames, jobRuntimeTaskCredentialNames, PostgresEventInbox, PostgresOutboxStore, readJobRuntimeOverride, recordDeclaredJobRuntime, type CommittedEventStore, type DeclaredJobRuntime, type JobRuntimeOverride } from "@__TRESTLE_PROJECT_NAME__/db";
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
      // A failed write must not turn the permanent failure into a retry; settlement dead-letters the event at the attempt cap instead.
      await input.outbox.reject?.(input.envelope.id, error.reason).catch((rejectError: unknown) => input.log.error(`${prefix}.event.reject_failed`, { ...fields, errorCategory: safeErrorCategory(rejectError) }));
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

/** An http(s) origin and path with no credentials, query, or fragment; anything else is not recorded. */
function publicEndpoint(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname}`.replace(/\/$/u, "");
  } catch { return null; }
}

/**
 * The runtime this Worker was deployed with, for the admin Jobs view. Hosting
 * is inferred from the configured endpoint: none (or the vendor's own API)
 * means the vendor's cloud. Secrets are never read into it.
 */
export function declaredJobRuntime(environment: WorkerEnvironment): DeclaredJobRuntime {
  return { ...deployedJobRuntime(environment), available: [...adapters.keys()].sort(), credentials: credentialPresence(environment) };
}

/** Whether each runtime credential is set on this Worker; the admin shows set or missing, never a value. */
function credentialPresence(environment: WorkerEnvironment): Record<string, boolean> {
  const variables = environment as WorkerEnvironment & Readonly<Record<string, unknown>>;
  const names = [...new Set([...Object.values(jobRuntimeCredentialNames), ...Object.values(jobRuntimeTaskCredentialNames)].flat())].sort();
  return Object.fromEntries(names.map((name) => [name, typeof variables[name] === "string" && variables[name] !== ""]));
}

function deployedJobRuntime(environment: WorkerEnvironment): DeclaredJobRuntime {
  const name = jobRuntime(environment).name;
  const variables = environment as WorkerEnvironment & Readonly<{ TRIGGER_API_URL?: string; TRIGGER_PROJECT_REF?: string; INNGEST_BASE_URL?: string }>;
  if (name === "trigger") {
    const endpoint = publicEndpoint(variables.TRIGGER_API_URL);
    const project = variables.TRIGGER_PROJECT_REF && /^[A-Za-z0-9_-]{1,64}$/u.test(variables.TRIGGER_PROJECT_REF) ? variables.TRIGGER_PROJECT_REF : null;
    return endpoint && new URL(endpoint).hostname !== "api.trigger.dev" ? { runtime: name, hosting: "self-hosted", endpoint, project } : { runtime: name, hosting: "cloud", endpoint: null, project };
  }
  if (name === "inngest") {
    const endpoint = publicEndpoint(variables.INNGEST_BASE_URL);
    return endpoint ? { runtime: name, hosting: "self-hosted", endpoint, project: null } : { runtime: name, hosting: "cloud", endpoint: null, project: null };
  }
  return { runtime: "cloudflare", hosting: "cloudflare", endpoint: null, project: null };
}

let lastDeclared: string | undefined;

/**
 * Records `declaredJobRuntime` for this environment from the safety sweep.
 * Once recorded, an isolate skips the database until the declaration
 * changes, and the database write itself is skipped when the row matches.
 */
export async function declareJobRuntime(environment: WorkerEnvironment, record: typeof recordDeclaredJobRuntime = recordDeclaredJobRuntime): Promise<boolean> {
  const declared = declaredJobRuntime(environment);
  const scope = environment.APP_ENV ?? "local";
  const fingerprint = JSON.stringify([scope, declared]);
  if (fingerprint === lastDeclared) return false;
  const written = await record(environment.DATABASE_URL, scope, declared);
  lastDeclared = fingerprint;
  return written;
}

/** Tests only: forget what this isolate already recorded. */
export function resetJobRuntimeDeclaration(): void { lastDeclared = undefined; }

/** How long an isolate reuses the admin override before reading it again. */
export const jobRuntimeOverrideCacheMs = 30_000;

/** Where the dispatcher sends committed events now, and whether an operator paused dispatch. */
export type DispatchJobRuntime = Readonly<{ adapter: JobRuntimeAdapter; environment: WorkerEnvironment; paused: boolean; source: "declared" | "override" }>;

let cachedOverride: { scope: string; at: number; value: JobRuntimeOverride | null } | undefined;

/** The Worker environment with an override's endpoint and project applied, for the override runtime's publisher. */
function overrideEnvironment(environment: WorkerEnvironment, override: JobRuntimeOverride): WorkerEnvironment {
  const selfHosted = override.hosting === "self-hosted" ? override.endpoint ?? undefined : undefined;
  if (override.runtime === "trigger") return { ...environment, TRIGGER_API_URL: selfHosted, ...(override.project ? { TRIGGER_PROJECT_REF: override.project } : {}) } as WorkerEnvironment;
  if (override.runtime === "inngest") return { ...environment, INNGEST_BASE_URL: selfHosted } as WorkerEnvironment;
  return environment;
}

/**
 * The runtime the dispatcher publishes to: the admin override when one is
 * set and its adapter is installed here, else TRESTLE_JOB_RUNTIME. The
 * override is read at most every 30 seconds per isolate. When the read
 * fails, dispatch fails closed to the deployed configuration; an override
 * naming an uninstalled runtime is logged and ignored. Only the dispatch
 * target changes: consumers (the Queue consumer, the Inngest serve endpoint,
 * trigger.dev tasks) accept work from any runtime so in-flight runs drain,
 * and the inbox still completes each event exactly once.
 */
export async function dispatchJobRuntime(environment: WorkerEnvironment, log: Logger, dependencies: { read?: typeof readJobRuntimeOverride; now?: () => number } = {}): Promise<DispatchJobRuntime> {
  const read = dependencies.read ?? readJobRuntimeOverride;
  const now = (dependencies.now ?? Date.now)();
  const scope = environment.APP_ENV ?? "local";
  let override: JobRuntimeOverride | null;
  if (cachedOverride && cachedOverride.scope === scope && now - cachedOverride.at < jobRuntimeOverrideCacheMs) override = cachedOverride.value;
  else {
    try {
      override = await read(environment.DATABASE_URL, scope);
      cachedOverride = { scope, at: now, value: override };
    } catch (error) {
      log.warn("jobs.runtime.override_unavailable", { errorCategory: safeErrorCategory(error) });
      return { adapter: jobRuntime(environment), environment, paused: false, source: "declared" };
    }
  }
  const paused = override?.settings.dispatchPaused ?? false;
  if (override?.runtime) {
    const adapter = adapters.get(override.runtime as JobRuntimeName);
    if (adapter) return { adapter, environment: overrideEnvironment(environment, override), paused, source: "override" };
    log.error("jobs.runtime.override_ignored", { runtime: override.runtime, reason: "adapter_not_installed" });
  }
  return { adapter: jobRuntime(environment), environment, paused, source: "declared" };
}

/**
 * The dispatch target from this isolate's last override read, without a
 * database round trip (the deployed configuration before the first read).
 * Used only to decide whether a commit should wake the dispatcher.
 */
export function cachedDispatchJobRuntime(environment: WorkerEnvironment): Pick<DispatchJobRuntime, "adapter" | "environment"> {
  const override = cachedOverride?.scope === (environment.APP_ENV ?? "local") ? cachedOverride.value : null;
  const adapter = override?.runtime ? adapters.get(override.runtime as JobRuntimeName) : undefined;
  return adapter && override ? { adapter, environment: overrideEnvironment(environment, override) } : { adapter: jobRuntime(environment), environment };
}

/** Tests only: forget the cached admin override. */
export function resetJobRuntimeOverrideCache(): void { cachedOverride = undefined; }
