import { createLogger } from "@__TRESTLE_PROJECT_NAME__/context";
import { recordDeclaredJobRuntime } from "@__TRESTLE_PROJECT_NAME__/db";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatchJobRuntime, registerJobRuntime, resetJobRuntimeOverrideCache } from "./job-runtime.js";
import { drainOutbox } from "./scheduler-runtime.js";
import type { WorkerEnvironment } from "./worker-environment.js";

const databaseUrl = process.env.TRESTLE_SYSTEM_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false }) : undefined;
// A scope of its own, so no other suite's configuration is read or changed.
const scope = `dispatch${Date.now()}`;

suite("dispatch runtime from the admin override", () => {
  const sent: unknown[] = [];
  const environment = () => ({ DATABASE_URL: databaseUrl!, BETTER_AUTH_SECRET: "x".repeat(32), APP_ENV: scope, TRESTLE_EVENTS: { send: async (body: unknown) => { sent.push(body); } } }) as unknown as WorkerEnvironment;
  const log = createLogger({ test: "job-runtime-dispatch" });

  beforeEach(() => { resetJobRuntimeOverrideCache(); sent.length = 0; });
  afterAll(async () => {
    await sql!`delete from job_runtime_config where environment = ${scope}`;
    await sql!.end();
  });

  it("reads the override as the application role and dispatches to the override runtime", async () => {
    await recordDeclaredJobRuntime(databaseUrl!, scope, { runtime: "cloudflare", hosting: "cloudflare", endpoint: null, project: null, available: ["cloudflare", "trigger"], credentials: {} });
    expect(await dispatchJobRuntime(environment(), log)).toMatchObject({ source: "declared", paused: false });
    const seen: WorkerEnvironment[] = [];
    registerJobRuntime({ name: "trigger", publisher: (target) => { seen.push(target); return undefined; }, describe: () => ({ configured: false, detail: "test" }) });
    await sql!`update job_runtime_config set override_runtime = 'trigger', override_hosting = 'self-hosted', override_endpoint = 'https://jobs.example.test', override_version = override_version + 1 where environment = ${scope}`;
    resetJobRuntimeOverrideCache();
    const target = await dispatchJobRuntime(environment(), log);
    expect(target.adapter.name).toBe("trigger");
    target.adapter.publisher(target.environment);
    expect(seen[0]).toMatchObject({ TRIGGER_API_URL: "https://jobs.example.test" });
    await sql!`update job_runtime_config set override_runtime = null, override_hosting = null, override_endpoint = null where environment = ${scope}`;
  });

  it("holds committed events pending while dispatch is paused", async () => {
    await sql!`update job_runtime_config set override_settings = ${sql!.json({ dispatchPaused: true })} where environment = ${scope}`;
    const id = crypto.randomUUID();
    await sql!`insert into outbox_message (id, event_name, schema_version, occurred_at, resource_type, resource_id, organization_id, correlation_id, idempotency_key, payload, status, attempts, available_at)
      values (${id}, 'article.published', 1, now(), 'article', 'a1', null, 'pause-corr', ${`pause-${id}`}, ${sql!.json({})}, 'pending', 0, now())`;
    try {
      const now = new Date();
      const result = await drainOutbox(environment(), { now: () => now });
      expect(result).toMatchObject({ sent: 0, failed: 0, paused: true });
      // Pending work is checked again after the cache window, so resuming takes effect without a new commit.
      expect(result.next!.getTime()).toBe(now.getTime() + 30_000);
      expect(sent).toEqual([]);
      const [row] = await sql!<{ status: string; attempts: number }[]>`select status, attempts from outbox_message where id = ${id}`;
      expect(row).toEqual({ status: "pending", attempts: 0 });
    } finally {
      await sql!`delete from outbox_message where id = ${id}`;
      await sql!`update job_runtime_config set override_settings = null where environment = ${scope}`;
    }
  });
});
