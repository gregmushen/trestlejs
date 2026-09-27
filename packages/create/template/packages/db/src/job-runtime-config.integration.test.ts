import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { createPlatformDatabase } from "./index.js";
import {
  clearJobRuntimeOverride, effectiveJobRuntime, jobDispatchHealth, JobRuntimeChangeError, jobRuntimeState, readJobRuntimeOverride, recordDeclaredJobRuntime, setJobDispatchPaused, setJobRuntimeOverride, settleUnconsumedJobs,
} from "./job-runtime-config.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const environment = `jobs${Date.now()}`;

async function failure(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) { return (error as Error).message; }
  return "resolved";
}

async function as<T>(role: "trestle_app" | "trestle_platform", work: (transaction: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return await sql!.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${role}`);
    return await work(transaction);
  }) as T;
}

suite("job runtime configuration", () => {
  afterAll(async () => {
    await sql!`delete from job_runtime_config where environment = ${environment}`;
    await sql!.end();
  });

  it("records the declared runtime only when it changes", async () => {
    const declared = { runtime: "trigger", hosting: "self-hosted", endpoint: "https://jobs.example.test", project: "proj_1" } as const;
    expect(await recordDeclaredJobRuntime(connectionString!, environment, declared)).toBe(true);
    const [first] = await sql!<{ declared_at: Date }[]>`select declared_at from job_runtime_config where environment = ${environment}`;
    expect(await recordDeclaredJobRuntime(connectionString!, environment, declared)).toBe(false);
    const [second] = await sql!<{ declared_at: Date }[]>`select declared_at from job_runtime_config where environment = ${environment}`;
    expect(second!.declared_at.getTime()).toBe(first!.declared_at.getTime());
    expect(await recordDeclaredJobRuntime(connectionString!, environment, { ...declared, project: null })).toBe(true);
    expect(await recordDeclaredJobRuntime(connectionString!, environment, { ...declared, project: null })).toBe(false);
  });

  it("lets the application declare but never override", async () => {
    expect(await failure(as("trestle_app", (transaction) => transaction`update job_runtime_config set override_runtime = 'inngest' where environment = ${environment}`))).toMatch(/permission denied/u);
    expect(await failure(as("trestle_app", (transaction) => transaction`insert into job_runtime_config (environment, declared_runtime, declared_hosting, override_runtime) values (${`${environment}-x`}, 'cloudflare', 'cloudflare', 'trigger')`))).toMatch(/permission denied/u);
  });

  it("gives the platform role the effective runtime and dispatch health, but never the declared columns", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    try {
      expect(await effectiveJobRuntime(platform, environment)).toMatchObject({ runtime: "trigger", hosting: "self-hosted", endpoint: "https://jobs.example.test", project: null, source: "declared" });
      expect(await effectiveJobRuntime(platform, `${environment}-missing`)).toBeNull();
      const health = await jobDispatchHealth(platform);
      for (const count of [health.pending, health.unconsumed, health.dead]) expect(count).toBeGreaterThanOrEqual(0);
    } finally { await platform.$client.end(); }
    expect(await failure(as("trestle_platform", (transaction) => transaction`update job_runtime_config set declared_runtime = 'inngest' where environment = ${environment}`))).toMatch(/permission denied/u);
    expect(await failure(as("trestle_platform", (transaction) => transaction`insert into job_runtime_config (environment, declared_runtime, declared_hosting) values (${`${environment}-p`}, 'cloudflare', 'cloudflare')`))).toMatch(/permission denied/u);
    expect(await failure(as("trestle_platform", (transaction) => transaction`delete from job_runtime_config where environment = ${environment}`))).toMatch(/permission denied/u);
    expect(await failure(as("trestle_platform", (transaction) => transaction`select claim_token from event_inbox limit 1`))).toMatch(/permission denied/u);
  });

  const context = (reason: string) => ({ actor: { type: "platform_operator" as const, id: "operator-jobs" }, reason, environment: "local", correlationId: `corr-${environment}` });

  it("limits the platform role to override columns and the application to declared columns", async () => {
    // Platform writes overrides but never what the Worker declared.
    for (const column of ["declared_runtime", "declared_available", "declared_credentials", "declared_at"]) {
      expect(await failure(as("trestle_platform", (transaction) => transaction.unsafe(`update job_runtime_config set ${column} = ${column} where environment = $1`, [environment])))).toMatch(/permission denied/u);
    }
    // The application reads the override for dispatch but never writes it.
    for (const column of ["override_runtime", "override_settings", "override_version", "switched_from", "overridden_by"]) {
      expect(await failure(as("trestle_app", (transaction) => transaction.unsafe(`update job_runtime_config set ${column} = ${column} where environment = $1`, [environment])))).toMatch(/permission denied/u);
    }
    expect(await as("trestle_app", (transaction) => transaction`select override_runtime, override_settings, override_version from job_runtime_config where environment = ${environment}`)).toHaveLength(1);
  });

  it("sets, pauses, and clears an override under optimistic concurrency, auditing before and after without secrets", async () => {
    await recordDeclaredJobRuntime(connectionString!, environment, { runtime: "cloudflare", hosting: "cloudflare", endpoint: null, project: null, available: ["cloudflare", "inngest", "trigger"], credentials: { TRIGGER_SECRET_KEY: true, INNGEST_EVENT_KEY: true, INNGEST_SIGNING_KEY: false } });
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    try {
      const state = await jobRuntimeState(platform, environment);
      expect(state).toMatchObject({ available: ["cloudflare", "inngest", "trigger"], credentials: { TRIGGER_SECRET_KEY: true, INNGEST_SIGNING_KEY: false }, override: null });
      const version = state!.overrideVersion;
      const target = { runtime: "trigger", hosting: "cloud", endpoint: null, project: "proj_abc" };
      // Experimental targets need an acknowledgement; missing credentials and uninstalled adapters are refused with codes.
      const codes = async (work: Promise<unknown>) => { try { await work; } catch (error) { return error instanceof JobRuntimeChangeError ? error.problems.map((problem) => problem.code) : (error as Error).message; } return []; };
      expect(await codes(setJobRuntimeOverride(platform, environment, { ...target, expectedVersion: version }, context("switch")))).toEqual(["experimental_not_acknowledged"]);
      expect(await codes(setJobRuntimeOverride(platform, environment, { runtime: "inngest", hosting: "cloud", endpoint: null, project: null, expectedVersion: version, acknowledgeExperimental: true }, context("switch")))).toEqual(["credentials_missing"]);
      expect(await failure(setJobRuntimeOverride(platform, environment, { ...target, expectedVersion: version + 5, acknowledgeExperimental: true }, context("switch")))).toMatch(/changed since you reviewed/u);
      expect(await setJobRuntimeOverride(platform, environment, { ...target, expectedVersion: version, acknowledgeExperimental: true }, context("move heavy jobs"))).toEqual({ version: version + 1 });
      // A second writer holding the old version loses.
      expect(await failure(setJobRuntimeOverride(platform, environment, { ...target, expectedVersion: version, acknowledgeExperimental: true }, context("again")))).toMatch(/changed since you reviewed/u);
      expect(await effectiveJobRuntime(platform, environment)).toMatchObject({ runtime: "trigger", hosting: "cloud", project: "proj_abc", source: "override" });
      expect(await jobRuntimeState(platform, environment)).toMatchObject({ switchedFrom: "cloudflare", overriddenBy: "operator-jobs" });
      // The Worker reads it as trestle_app.
      expect(await readJobRuntimeOverride(connectionString!, environment)).toEqual({ runtime: "trigger", hosting: "cloud", endpoint: null, project: "proj_abc", settings: { dispatchPaused: false }, version: version + 1 });
      expect(await setJobDispatchPaused(platform, environment, { paused: true, expectedVersion: version + 1 }, context("incident"))).toEqual({ version: version + 2 });
      expect((await readJobRuntimeOverride(connectionString!, environment))?.settings).toEqual({ dispatchPaused: true });
      expect(await clearJobRuntimeOverride(platform, environment, { expectedVersion: version + 2 }, context("back to deploy"))).toEqual({ version: version + 3 });
      expect(await jobRuntimeState(platform, environment)).toMatchObject({ override: null, settings: { dispatchPaused: false }, switchedFrom: "trigger", effective: { runtime: "cloudflare", source: "declared" } });
      expect(await failure(clearJobRuntimeOverride(platform, environment, { expectedVersion: version + 3 }, context("again")))).toMatch(/no admin override/u);
      expect(await failure(setJobRuntimeOverride(platform, `${environment}-missing`, { ...target, expectedVersion: 0, acknowledgeExperimental: true }, context("x")))).toMatch(/has not declared/u);
    } finally { await platform.$client.end(); }
    const audits = await sql!<{ name: string; actor_id: string; reason: string; summary: Record<string, any>; correlation_id: string }[]>`select name, actor_id, reason, summary, correlation_id from audit_event where target_type = 'job_runtime_config' and target_id = ${environment} order by occurred_at, name`;
    expect(audits.map((audit) => [audit.name, audit.reason])).toEqual([["platform.job_runtime.overridden", "move heavy jobs"], ["platform.job_dispatch.paused", "incident"], ["platform.job_runtime.override_cleared", "back to deploy"]]);
    expect(audits[0]).toMatchObject({ actor_id: "operator-jobs", correlation_id: `corr-${environment}`, summary: { before: { runtime: "cloudflare", source: "declared" }, after: { runtime: "trigger", project: "proj_abc", source: "override" }, switched: true } });
    expect(JSON.stringify(audits)).not.toMatch(/credentials|SECRET_KEY|SIGNING_KEY/u);
  });

  it("settles unconsumed events through a function only the platform role may run", async () => {
    const ids = { stale: crypto.randomUUID(), capped: crypto.randomUUID() };
    const insert = (id: string, attempts: number) => sql!`insert into outbox_message (id, event_name, schema_version, occurred_at, resource_type, resource_id, organization_id, correlation_id, idempotency_key, payload, status, attempts, available_at, processed_at)
      values (${id}, 'article.published', 1, now() - interval '10 days', 'article', 'a1', null, 'settle-corr', ${`settle-${id}`}, ${sql!.json({})}, 'succeeded', ${attempts}, now() - interval '10 days', now() - interval '10 days')`;
    await insert(ids.stale, 1);
    await insert(ids.capped, 4);
    try {
      expect(await failure(as("trestle_app", (transaction) => transaction`select * from trestle_settle_unconsumed_jobs(0, 5, 10)`))).toMatch(/permission denied/u);
      expect(await failure(as("trestle_platform", (transaction) => transaction`select * from trestle_settle_unconsumed_jobs(0, 5, 100000)`))).toMatch(/invalid settlement parameters/u);
      const platform = createPlatformDatabase(connectionString!, "postgres-js");
      try {
        expect(await failure(settleUnconsumedJobs(platform, environment, { olderThanMinutes: -1 }, context("x")))).toMatch(/olderThanMinutes/u);
        // Only rows processed more than nine days ago: this test's own.
        const result = await settleUnconsumedJobs(platform, environment, { olderThanMinutes: 9 * 24 * 60 }, context("drain trigger"));
        expect(result.requeued).toBeGreaterThanOrEqual(1);
        expect(result.deadLettered).toBeGreaterThanOrEqual(1);
      } finally { await platform.$client.end(); }
      const rows = await sql!<{ id: string; status: string; attempts: number; last_error: string | null }[]>`select id, status, attempts, last_error from outbox_message where id in (${ids.stale}, ${ids.capped})`;
      expect(rows.find((row) => row.id === ids.stale)).toMatchObject({ status: "pending", attempts: 2 });
      expect(rows.find((row) => row.id === ids.capped)).toMatchObject({ status: "dead", last_error: "unconsumed_after_retries" });
      const [audit] = await sql!<{ summary: Record<string, unknown> }[]>`select summary from audit_event where name = 'platform.job_dispatch.settled' and target_id = ${environment}`;
      expect(audit?.summary).toMatchObject({ olderThanMinutes: 12_960, maxAttempts: 5 });
    } finally {
      await sql!`delete from outbox_message where id in (${ids.stale}, ${ids.capped})`;
    }
  });
});
