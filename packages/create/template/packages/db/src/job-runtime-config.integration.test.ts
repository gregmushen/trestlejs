import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { createPlatformDatabase } from "./index.js";
import { effectiveJobRuntime, jobDispatchHealth, recordDeclaredJobRuntime } from "./job-runtime-config.js";

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

  it("gives the platform role read-only access to the effective runtime and dispatch health", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    try {
      expect(await effectiveJobRuntime(platform, environment)).toMatchObject({ runtime: "trigger", hosting: "self-hosted", endpoint: "https://jobs.example.test", project: null, source: "declared" });
      expect(await effectiveJobRuntime(platform, `${environment}-missing`)).toBeNull();
      const health = await jobDispatchHealth(platform);
      for (const count of [health.pending, health.unconsumed, health.dead]) expect(count).toBeGreaterThanOrEqual(0);
    } finally { await platform.$client.end(); }
    expect(await failure(as("trestle_platform", (transaction) => transaction`update job_runtime_config set override_runtime = 'inngest' where environment = ${environment}`))).toMatch(/permission denied/u);
    expect(await failure(as("trestle_platform", (transaction) => transaction`insert into job_runtime_config (environment, declared_runtime, declared_hosting) values (${`${environment}-p`}, 'cloudflare', 'cloudflare')`))).toMatch(/permission denied/u);
    expect(await failure(as("trestle_platform", (transaction) => transaction`delete from job_runtime_config where environment = ${environment}`))).toMatch(/permission denied/u);
    expect(await failure(as("trestle_platform", (transaction) => transaction`select claim_token from event_inbox limit 1`))).toMatch(/permission denied/u);
  });
});
