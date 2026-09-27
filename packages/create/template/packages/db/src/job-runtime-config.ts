import { eq, sql } from "drizzle-orm";
import postgres from "postgres";

import type { Database } from "./index.js";
import { jobRuntimeConfig } from "./job-runtime-schema.js";
import { outboxApplicationConnectionString } from "./outbox.js";

export type JobRuntimeHosting = "cloud" | "self-hosted" | "cloudflare";

/** What the customer Worker was deployed with. Never a credential. */
export type DeclaredJobRuntime = Readonly<{ runtime: "cloudflare" | "trigger" | "inngest"; hosting: JobRuntimeHosting; endpoint: string | null; project: string | null }>;

/**
 * Records the Worker's deploy-time job runtime for its environment, as
 * trestle_app, whose grants cover only the declared_* columns. The row is
 * written only when a value differs, so an unchanged deploy writes nothing.
 * Returns whether a row was inserted or changed.
 */
export async function recordDeclaredJobRuntime(connectionString: string, environment: string, declared: DeclaredJobRuntime): Promise<boolean> {
  const client = postgres(outboxApplicationConnectionString(connectionString), { max: 1, prepare: false });
  try {
    const rows = await client`insert into job_runtime_config (environment, declared_runtime, declared_hosting, declared_endpoint, declared_project, declared_at)
      values (${environment}, ${declared.runtime}, ${declared.hosting}, ${declared.endpoint}, ${declared.project}, now())
      on conflict (environment) do update set declared_runtime = excluded.declared_runtime, declared_hosting = excluded.declared_hosting, declared_endpoint = excluded.declared_endpoint, declared_project = excluded.declared_project, declared_at = excluded.declared_at
      where (job_runtime_config.declared_runtime, job_runtime_config.declared_hosting, job_runtime_config.declared_endpoint, job_runtime_config.declared_project)
        is distinct from (excluded.declared_runtime, excluded.declared_hosting, excluded.declared_endpoint, excluded.declared_project)
      returning environment`;
    return rows.length > 0;
  } finally {
    await client.end({ timeout: 1 });
  }
}

export type EffectiveJobRuntime = Readonly<{ runtime: string; hosting: string; endpoint: string | null; project: string | null; source: "declared" | "override"; declaredAt: Date }>;

/** The effective runtime for an environment (override ?? declared), or null before the Worker has declared one. */
export async function effectiveJobRuntime(database: Database, environment: string): Promise<EffectiveJobRuntime | null> {
  const [row] = await database.select({
    declaredRuntime: jobRuntimeConfig.declaredRuntime, declaredHosting: jobRuntimeConfig.declaredHosting, declaredEndpoint: jobRuntimeConfig.declaredEndpoint, declaredProject: jobRuntimeConfig.declaredProject, declaredAt: jobRuntimeConfig.declaredAt,
    overrideRuntime: jobRuntimeConfig.overrideRuntime, overrideHosting: jobRuntimeConfig.overrideHosting, overrideEndpoint: jobRuntimeConfig.overrideEndpoint, overrideProject: jobRuntimeConfig.overrideProject,
  }).from(jobRuntimeConfig).where(eq(jobRuntimeConfig.environment, environment)).limit(1);
  if (!row) return null;
  const overridden = row.overrideRuntime !== null;
  return {
    runtime: row.overrideRuntime ?? row.declaredRuntime, hosting: row.overrideHosting ?? row.declaredHosting,
    endpoint: overridden ? row.overrideEndpoint : row.declaredEndpoint, project: overridden ? row.overrideProject : row.declaredProject,
    source: overridden ? "override" : "declared", declaredAt: row.declaredAt,
  };
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
