import { eq, sql } from "drizzle-orm";
import postgres from "postgres";

import { recordAuditEvent } from "./audit.js";
import type { Database } from "./index.js";
import { jobRuntimeConfig } from "./job-runtime-schema.js";
import { outboxApplicationConnectionString } from "./outbox.js";
import { PlatformOperationError } from "./platform-operations.js";
import type { PlatformChangeContext } from "./platform-roles.js";

export type JobRuntimeHosting = "cloud" | "self-hosted" | "cloudflare";
export type JobRuntimeKind = "cloudflare" | "trigger" | "inngest";
export const jobRuntimeKinds: readonly JobRuntimeKind[] = ["cloudflare", "trigger", "inngest"];

/**
 * The Worker secrets each runtime needs before it can dispatch. The Worker
 * reports only whether each is set; values never leave it.
 */
export const jobRuntimeCredentialNames: Readonly<Record<JobRuntimeKind, readonly string[]>> = {
  cloudflare: [],
  trigger: ["TRIGGER_SECRET_KEY"],
  inngest: ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"],
};

/**
 * Credentials that job code needs where the runtime executes it outside the
 * Worker. trigger.dev tasks send email themselves, so they need the Resend key
 * (`trestle jobs env push` copies it); Cloudflare and Inngest send from the
 * Worker. Reported as presence on the Worker, and never required to switch.
 */
export const jobRuntimeTaskCredentialNames: Readonly<Record<JobRuntimeKind, readonly string[]>> = {
  cloudflare: [],
  trigger: ["RESEND_API_KEY"],
  inngest: [],
};

/** What the customer Worker was deployed with. Never a credential. */
export type DeclaredJobRuntime = Readonly<{
  runtime: JobRuntimeKind; hosting: JobRuntimeHosting; endpoint: string | null; project: string | null;
  /** Runtimes whose adapter is installed in this Worker. */
  available?: readonly string[];
  /** Presence of each runtime's credentials; never values. */
  credentials?: Readonly<Record<string, boolean>>;
}>;

/**
 * Records the Worker's deploy-time job runtime for its environment, as
 * trestle_app, whose grants cover only the declared_* columns. The row is
 * written only when a value differs, so an unchanged deploy writes nothing.
 * Returns whether a row was inserted or changed.
 */
export async function recordDeclaredJobRuntime(connectionString: string, environment: string, declared: DeclaredJobRuntime): Promise<boolean> {
  const client = postgres(outboxApplicationConnectionString(connectionString), { max: 1, prepare: false });
  try {
    // 1009 is text[]: without prepared statements the driver cannot infer the array type.
    const available = declared.available ? client.array([...declared.available], 1009) : null;
    const credentials = declared.credentials ? client.json({ ...declared.credentials }) : null;
    const rows = await client`insert into job_runtime_config (environment, declared_runtime, declared_hosting, declared_endpoint, declared_project, declared_available, declared_credentials, declared_at)
      values (${environment}, ${declared.runtime}, ${declared.hosting}, ${declared.endpoint}, ${declared.project}, ${available}::text[], ${credentials}::jsonb, now())
      on conflict (environment) do update set declared_runtime = excluded.declared_runtime, declared_hosting = excluded.declared_hosting, declared_endpoint = excluded.declared_endpoint, declared_project = excluded.declared_project,
        declared_available = excluded.declared_available, declared_credentials = excluded.declared_credentials, declared_at = excluded.declared_at
      where (job_runtime_config.declared_runtime, job_runtime_config.declared_hosting, job_runtime_config.declared_endpoint, job_runtime_config.declared_project, job_runtime_config.declared_available, job_runtime_config.declared_credentials)
        is distinct from (excluded.declared_runtime, excluded.declared_hosting, excluded.declared_endpoint, excluded.declared_project, excluded.declared_available, excluded.declared_credentials)
      returning environment`;
    return rows.length > 0;
  } finally {
    await client.end({ timeout: 1 });
  }
}

/** Operator settings the Worker honors at runtime. Only `dispatchPaused` exists: the Worker has no other tunable. */
export type JobRuntimeSettings = Readonly<{ dispatchPaused: boolean }>;

const settingsOf = (value: unknown): JobRuntimeSettings => ({ dispatchPaused: Boolean(value && typeof value === "object" && (value as { dispatchPaused?: unknown }).dispatchPaused === true) });

/** The admin override as the customer Worker reads it (trestle_app, override columns only). */
export type JobRuntimeOverride = Readonly<{ runtime: string | null; hosting: string | null; endpoint: string | null; project: string | null; settings: JobRuntimeSettings; version: number }>;

/**
 * Reads the admin override for the Worker's dispatcher, as trestle_app. Null
 * when the environment has no row yet. Failures propagate: the caller falls
 * back to its deploy-time configuration.
 */
export async function readJobRuntimeOverride(connectionString: string, environment: string): Promise<JobRuntimeOverride | null> {
  const client = postgres(outboxApplicationConnectionString(connectionString), { max: 1, prepare: false });
  try {
    const [row] = await client<{ override_runtime: string | null; override_hosting: string | null; override_endpoint: string | null; override_project: string | null; override_settings: unknown; override_version: number }[]>`select override_runtime, override_hosting, override_endpoint, override_project, override_settings, override_version
      from job_runtime_config where environment = ${environment}`;
    if (!row) return null;
    return { runtime: row.override_runtime, hosting: row.override_hosting, endpoint: row.override_endpoint, project: row.override_project, settings: settingsOf(row.override_settings), version: row.override_version };
  } finally {
    await client.end({ timeout: 1 });
  }
}

export type EffectiveJobRuntime = Readonly<{ runtime: string; hosting: string; endpoint: string | null; project: string | null; source: "declared" | "override"; declaredAt: Date }>;

/** The effective runtime for an environment (override ?? declared), or null before the Worker has declared one. */
export async function effectiveJobRuntime(database: Database, environment: string): Promise<EffectiveJobRuntime | null> {
  const state = await jobRuntimeState(database, environment);
  return state ? state.effective : null;
}

/** Everything the admin Jobs view needs about one environment's runtime. Never a credential value. */
export type JobRuntimeState = Readonly<{
  effective: EffectiveJobRuntime;
  declared: Readonly<{ runtime: string; hosting: string; endpoint: string | null; project: string | null }>;
  override: Readonly<{ runtime: string; hosting: string; endpoint: string | null; project: string | null }> | null;
  settings: JobRuntimeSettings;
  overrideVersion: number;
  overriddenBy: string | null;
  overriddenAt: Date | null;
  /** Null when the Worker predates availability reporting. */
  available: readonly string[] | null;
  credentials: Readonly<Record<string, boolean>> | null;
  switchedFrom: string | null;
  switchedAt: Date | null;
}>;

export async function jobRuntimeState(database: Database, environment: string): Promise<JobRuntimeState | null> {
  const [row] = await database.select().from(jobRuntimeConfig).where(eq(jobRuntimeConfig.environment, environment)).limit(1);
  if (!row) return null;
  const override = row.overrideRuntime !== null ? { runtime: row.overrideRuntime, hosting: row.overrideHosting ?? row.declaredHosting, endpoint: row.overrideEndpoint, project: row.overrideProject } : null;
  const declared = { runtime: row.declaredRuntime, hosting: row.declaredHosting, endpoint: row.declaredEndpoint, project: row.declaredProject };
  const credentials = row.declaredCredentials && typeof row.declaredCredentials === "object" && !Array.isArray(row.declaredCredentials)
    ? Object.fromEntries(Object.entries(row.declaredCredentials as Record<string, unknown>).map(([name, present]) => [name, present === true]))
    : null;
  return {
    effective: { ...(override ?? declared), source: override ? "override" : "declared", declaredAt: row.declaredAt },
    declared, override, settings: settingsOf(row.overrideSettings), overrideVersion: row.overrideVersion,
    overriddenBy: row.overriddenBy, overriddenAt: row.overriddenAt, available: row.declaredAvailable ?? null, credentials,
    switchedFrom: row.switchedFrom, switchedAt: row.switchedAt,
  };
}

export type JobRuntimeTarget = Readonly<{ runtime: string; hosting: string; endpoint: string | null; project: string | null }>;
export type JobRuntimeProblemCode = "invalid_runtime" | "invalid_hosting" | "invalid_endpoint" | "invalid_project" | "runtime_not_installed" | "credentials_missing" | "experimental_not_acknowledged" | "not_declared";
export type JobRuntimeProblem = Readonly<{ code: JobRuntimeProblemCode; message: string }>;

/** A change the target cannot take (HTTP 422); `problems` names each reason by code. */
export class JobRuntimeChangeError extends Error {
  readonly code = "unprocessable";
  constructor(readonly problems: readonly JobRuntimeProblem[]) {
    super(problems.map((problem) => problem.message).join(" "));
    this.name = "JobRuntimeChangeError";
  }
}

/** https anywhere, http only on the local machine; no credentials, query, or fragment. Returns the normalized URL or null. */
export function jobRuntimeEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname}`.replace(/\/$/u, "");
  } catch { return null; }
}

/** The runtime is experimental everywhere but Cloudflare until verified evidence ships with the admin. */
export const jobRuntimeExperimental = (runtime: string): boolean => runtime !== "cloudflare";

/**
 * Checks a target against what the Worker reported: the runtime's adapter is
 * installed, its hosting and location are well formed, and every credential
 * it needs is set. Returns the normalized target and each problem.
 */
export function validateJobRuntimeTarget(input: JobRuntimeTarget, state: Pick<JobRuntimeState, "available" | "credentials">): { target: JobRuntimeTarget; problems: JobRuntimeProblem[]; missingCredentials: string[] } {
  const problems: JobRuntimeProblem[] = [];
  const runtime = input.runtime;
  if (!(jobRuntimeKinds as readonly string[]).includes(runtime)) return { target: input, problems: [{ code: "invalid_runtime", message: "Choose cloudflare, trigger, or inngest." }], missingCredentials: [] };
  const hostings = runtime === "cloudflare" ? ["cloudflare"] : ["cloud", "self-hosted"];
  if (!hostings.includes(input.hosting)) problems.push({ code: "invalid_hosting", message: runtime === "cloudflare" ? "Cloudflare runs on Cloudflare." : "Choose the vendor cloud or self-hosted." });
  let endpoint: string | null = null;
  if (input.endpoint) {
    endpoint = jobRuntimeEndpoint(input.endpoint);
    if (!endpoint) problems.push({ code: "invalid_endpoint", message: "The endpoint must be an https URL (http only for localhost), without credentials, query, or fragment." });
    else if (input.hosting !== "self-hosted") problems.push({ code: "invalid_endpoint", message: "Only a self-hosted engine takes an endpoint." });
  } else if (input.hosting === "self-hosted") problems.push({ code: "invalid_endpoint", message: "A self-hosted engine needs its endpoint URL." });
  const project = input.project ? input.project.trim() : null;
  if (project && (runtime !== "trigger" || !/^proj_[A-Za-z0-9]{1,60}$/u.test(project))) problems.push({ code: "invalid_project", message: runtime === "trigger" ? "A trigger.dev project reference looks like proj_…" : "Only trigger.dev takes a project reference." });
  if (state.available === null || !state.available.includes(runtime)) problems.push({ code: "runtime_not_installed", message: `The deployed Worker does not have the ${runtime} adapter installed${state.available === null ? " (it has not reported its adapters yet)" : ""}.` });
  const missingCredentials = jobRuntimeCredentialNames[runtime as JobRuntimeKind].filter((name) => state.credentials?.[name] !== true);
  if (missingCredentials.length) problems.push({ code: "credentials_missing", message: `Set ${missingCredentials.join(", ")} on the Worker first.` });
  return { target: { runtime, hosting: input.hosting, endpoint, project }, problems, missingCredentials };
}

const auditContext = (context: PlatformChangeContext) => ({ actor: context.actor, environment: context.environment, correlationId: context.correlationId, ...(context.now ? { occurredAt: context.now } : {}) });

function requireReason(reason: string): string {
  const text = reason.trim();
  if (!text || text.length > 500) throw new PlatformOperationError("invalid", "A reason of at most 500 characters is required");
  return text;
}

type LockedRow = typeof jobRuntimeConfig.$inferSelect;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function lockedRow(transaction: Transaction, environment: string, expectedVersion: number): Promise<LockedRow> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new PlatformOperationError("invalid", "expectedVersion must be the override version you reviewed");
  const [row] = await transaction.select().from(jobRuntimeConfig).where(eq(jobRuntimeConfig.environment, environment)).for("update").limit(1);
  if (!row) throw new PlatformOperationError("not_found", "The Worker has not declared its job runtime for this environment yet");
  if (row.overrideVersion !== expectedVersion) throw new PlatformOperationError("conflict", "The job runtime changed since you reviewed it; reload and review again");
  return row;
}

/** Only the runtime, hosting, and location are audited: no column of this table holds a credential. */
const snapshot = (row: LockedRow) => ({
  runtime: row.overrideRuntime ?? row.declaredRuntime, hosting: row.overrideRuntime ? row.overrideHosting : row.declaredHosting,
  endpoint: row.overrideRuntime ? row.overrideEndpoint : row.declaredEndpoint, project: row.overrideRuntime ? row.overrideProject : row.declaredProject,
  source: row.overrideRuntime ? "override" : "declared", dispatchPaused: settingsOf(row.overrideSettings).dispatchPaused,
});

/**
 * Sets the admin override for an environment's job runtime, re-validated
 * against what the Worker reported, under optimistic concurrency on
 * override_version, and audits the before and after in the same transaction.
 */
export async function setJobRuntimeOverride(database: Database, environment: string, input: JobRuntimeTarget & Readonly<{ expectedVersion: number; acknowledgeExperimental?: boolean }>, context: PlatformChangeContext): Promise<{ version: number }> {
  const reason = requireReason(context.reason);
  return await database.transaction(async (transaction) => {
    const row = await lockedRow(transaction, environment, input.expectedVersion);
    const { target, problems } = validateJobRuntimeTarget(input, { available: row.declaredAvailable ?? null, credentials: (row.declaredCredentials ?? null) as Record<string, boolean> | null });
    if (jobRuntimeExperimental(target.runtime) && input.acknowledgeExperimental !== true) problems.push({ code: "experimental_not_acknowledged", message: `${target.runtime} is experimental; acknowledge it to switch.` });
    if (problems.length) throw new JobRuntimeChangeError(problems);
    const before = snapshot(row);
    const switched = before.runtime !== target.runtime || before.hosting !== target.hosting;
    const version = row.overrideVersion + 1;
    await transaction.update(jobRuntimeConfig).set({
      overrideRuntime: target.runtime, overrideHosting: target.hosting, overrideEndpoint: target.endpoint, overrideProject: target.project,
      overrideVersion: version, overriddenBy: context.actor.id, overriddenAt: sql`now()`,
      ...(switched ? { switchedFrom: before.runtime, switchedAt: sql`now()` } : {}),
    }).where(eq(jobRuntimeConfig.environment, environment));
    await recordAuditEvent(transaction, {
      ...auditContext(context), name: "platform.job_runtime.overridden", organizationId: null, target: { type: "job_runtime_config", id: environment },
      reason, summary: { before, after: { ...target, source: "override", dispatchPaused: before.dispatchPaused }, switched, version },
    });
    return { version };
  });
}

/** Clears the override and its settings: the Worker returns to its deployed configuration. Audited. */
export async function clearJobRuntimeOverride(database: Database, environment: string, input: Readonly<{ expectedVersion: number }>, context: PlatformChangeContext): Promise<{ version: number }> {
  const reason = requireReason(context.reason);
  return await database.transaction(async (transaction) => {
    const row = await lockedRow(transaction, environment, input.expectedVersion);
    if (row.overrideRuntime === null && row.overrideSettings === null) throw new PlatformOperationError("conflict", "There is no admin override to clear");
    const before = snapshot(row);
    const switched = before.runtime !== row.declaredRuntime || before.hosting !== row.declaredHosting;
    const version = row.overrideVersion + 1;
    await transaction.update(jobRuntimeConfig).set({
      overrideRuntime: null, overrideHosting: null, overrideEndpoint: null, overrideProject: null, overrideSettings: null,
      overrideVersion: version, overriddenBy: context.actor.id, overriddenAt: sql`now()`,
      ...(switched ? { switchedFrom: before.runtime, switchedAt: sql`now()` } : {}),
    }).where(eq(jobRuntimeConfig.environment, environment));
    await recordAuditEvent(transaction, {
      ...auditContext(context), name: "platform.job_runtime.override_cleared", organizationId: null, target: { type: "job_runtime_config", id: environment },
      reason, summary: { before, after: { runtime: row.declaredRuntime, hosting: row.declaredHosting, endpoint: row.declaredEndpoint, project: row.declaredProject, source: "declared", dispatchPaused: false }, switched, version },
    });
    return { version };
  });
}

/** Pauses or resumes dispatch: while paused the Worker sends nothing and committed events stay pending. Audited. */
export async function setJobDispatchPaused(database: Database, environment: string, input: Readonly<{ paused: boolean; expectedVersion: number }>, context: PlatformChangeContext): Promise<{ version: number }> {
  const reason = requireReason(context.reason);
  return await database.transaction(async (transaction) => {
    const row = await lockedRow(transaction, environment, input.expectedVersion);
    const before = settingsOf(row.overrideSettings);
    const version = row.overrideVersion + 1;
    await transaction.update(jobRuntimeConfig).set({ overrideSettings: { dispatchPaused: input.paused }, overrideVersion: version, overriddenBy: context.actor.id, overriddenAt: sql`now()` })
      .where(eq(jobRuntimeConfig.environment, environment));
    await recordAuditEvent(transaction, {
      ...auditContext(context), name: input.paused ? "platform.job_dispatch.paused" : "platform.job_dispatch.resumed", organizationId: null, target: { type: "job_runtime_config", id: environment },
      reason, summary: { before, after: { dispatchPaused: input.paused }, version },
    });
    return { version };
  });
}

/**
 * Re-dispatches committed events no consumer completed, as the Worker's
 * safety sweep does for external runtimes: dead-letters those at the attempt
 * cap and returns the rest to pending, at most `limit` of each. Runs a
 * narrowly granted database function; audited with the counts.
 */
export async function settleUnconsumedJobs(database: Database, environment: string, input: Readonly<{ olderThanMinutes: number; maxAttempts?: number; limit?: number }>, context: PlatformChangeContext): Promise<{ deadLettered: number; requeued: number }> {
  const reason = requireReason(context.reason);
  if (!Number.isInteger(input.olderThanMinutes) || input.olderThanMinutes < 0 || input.olderThanMinutes > 20_160) throw new PlatformOperationError("invalid", "olderThanMinutes must be a whole number of minutes, at most 14 days");
  const maxAttempts = input.maxAttempts ?? 5;
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 1000);
  return await database.transaction(async (transaction) => {
    const [row] = await transaction.select({ deadLettered: sql<number>`dead_lettered`, requeued: sql<number>`requeued` })
      .from(sql`trestle_settle_unconsumed_jobs(${input.olderThanMinutes * 60_000}::bigint, ${maxAttempts}::integer, ${limit}::integer)`);
    const result = { deadLettered: Number(row?.deadLettered ?? 0), requeued: Number(row?.requeued ?? 0) };
    await recordAuditEvent(transaction, {
      ...auditContext(context), name: "platform.job_dispatch.settled", organizationId: null, target: { type: "job_runtime_config", id: environment },
      reason, summary: { olderThanMinutes: input.olderThanMinutes, maxAttempts, limit, ...result },
    });
    return result;
  });
}

export type JobDispatchHealth = Readonly<{ pending: number; unconsumed: number; dead: number }>;

/**
 * The same counts as `trestle jobs migrate` (pending, dispatched inside the
 * replay window but never completed, dead-lettered). The platform role
 * cannot read event_inbox, so the counts come from a narrowly granted
 * database function that returns only these totals.
 */
export async function jobDispatchHealth(database: Database): Promise<JobDispatchHealth> {
  const [row] = await database.select({ pending: sql<number>`pending`, unconsumed: sql<number>`unconsumed`, dead: sql<number>`dead` }).from(sql`trestle_job_dispatch_health()`);
  return { pending: Number(row?.pending ?? 0), unconsumed: Number(row?.unconsumed ?? 0), dead: Number(row?.dead ?? 0) };
}
