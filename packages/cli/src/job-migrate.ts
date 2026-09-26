import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type JobRuntimeName = "cloudflare" | "trigger" | "inngest";

export type MigrationInventory = Readonly<{
  /** Committed events not yet handed to any runtime; the new owner dispatches them. */
  pending: number;
  /** Handed to a runtime inside the replay window but not completed by any consumer. */
  unconsumed: number;
  /** Dead-lettered after repeated dispatch failures; redrive them explicitly. */
  dead: number;
}>;

/** Reads the outbox and inbox with the project's own PostgreSQL client, so the CLI carries no driver. */
export async function migrationInventory(root: string, databasePackage: string, url: string): Promise<MigrationInventory> {
  const script = `const postgres = require("postgres"); const sql = postgres(process.env.TRESTLE_MIGRATE_DATABASE_URL, { max: 1, connect_timeout: 5, onnotice: () => {} });
(async () => {
  const [row] = await sql\`select
    count(*) filter (where o.status in ('pending','leased'))::int as pending,
    count(*) filter (where o.status = 'succeeded' and o.occurred_at > now() - interval '14 days' and not exists (select 1 from event_inbox i where i.idempotency_key = o.idempotency_key and i.status = 'completed'))::int as unconsumed,
    count(*) filter (where o.status = 'dead')::int as dead
    from outbox_message o\`;
  process.stdout.write(JSON.stringify(row));
})().catch((error) => { process.stderr.write(error.message); process.exitCode = 1; }).finally(() => sql.end({ timeout: 1 }));`;
  const { stdout } = await run(process.execPath, ["-e", script], { cwd: path.join(root, databasePackage), env: { ...process.env, TRESTLE_MIGRATE_DATABASE_URL: url }, timeout: 20_000 });
  return JSON.parse(stdout) as MigrationInventory;
}

/** Re-dispatches events no consumer completed; the Worker's dispatcher sends them to the current runtime. */
export async function settleForMigration(root: string, databasePackage: string, url: string, olderThanMinutes: number): Promise<number> {
  const script = `const postgres = require("postgres"); const sql = postgres(process.env.TRESTLE_MIGRATE_DATABASE_URL, { max: 1, connect_timeout: 5, onnotice: () => {} });
(async () => {
  const rows = await sql\`update outbox_message set status='pending', available_at=now(), attempts=attempts+1, processed_at=null
    where id in (select o.id from outbox_message o where o.status='succeeded' and o.processed_at <= now() - (\${Number(process.env.TRESTLE_MIGRATE_OLDER_THAN_MINUTES)} * interval '1 minute') and o.occurred_at > now() - interval '14 days' and o.attempts + 1 < 5
      and not exists (select 1 from event_inbox i where i.idempotency_key = o.idempotency_key and i.status = 'completed') for update skip locked) returning id\`;
  process.stdout.write(String(rows.length));
})().catch((error) => { process.stderr.write(error.message); process.exitCode = 1; }).finally(() => sql.end({ timeout: 1 }));`;
  const { stdout } = await run(process.execPath, ["-e", script], { cwd: path.join(root, databasePackage), env: { ...process.env, TRESTLE_MIGRATE_DATABASE_URL: url, TRESTLE_MIGRATE_OLDER_THAN_MINUTES: String(olderThanMinutes) }, timeout: 20_000 });
  return Number(stdout);
}

/** The ordered, reviewable switch from one runtime to another. Each step is a supported command. */
export function migrationSteps(from: JobRuntimeName, to: JobRuntimeName, environment: string): string[] {
  const use = to === "cloudflare" ? "pnpm exec trestle jobs use cloudflare --yes" : `pnpm exec trestle jobs use ${to} --yes${to === "trigger" ? " --project proj_…" : ""}   # add --endpoint for self-hosted`;
  const configure = to === "trigger"
    ? [`pnpm exec trestle secrets set TRIGGER_SECRET_KEY --env ${environment}`, `pnpm exec trestle jobs env push --env ${environment}${environment === "production" ? " --yes" : ""}`, "pnpm --filter ./apps/jobs deploy   # tasks must exist before the Worker dispatches to them"]
    : to === "inngest"
      ? [`pnpm exec trestle secrets set INNGEST_EVENT_KEY --env ${environment}`, `pnpm exec trestle secrets set INNGEST_SIGNING_KEY --env ${environment}`]
      : ["# Cloudflare Queues (and Workflows, if enabled) must be provisioned: pnpm exec trestle doctor --env " + environment];
  return [
    `1. Switch the source: ${use}`,
    ...configure.map((step, index) => `${index === 0 ? "2. Configure the new runtime" : "  "}: ${step}`),
    `3. Deploy the Worker${to === "inngest" ? ", then register https://<worker>/api/jobs/inngest as the Inngest app URL" : ""}. That deploy moves the dispatch owner to ${to} atomically: from then on, pending events go only to ${to}.`,
    `4. Let ${from} drain what it already accepted. Keep its bindings and code deployed; ${from === "cloudflare" ? "the Worker's Queue consumer and Workflows keep running" : `${from} keeps running its accepted runs`}.`,
    `5. After its runs have ended, re-dispatch anything ${from} accepted but never completed: pnpm exec trestle jobs migrate --to ${to} --env ${environment} --settle --yes`,
    `6. Remove ${from}'s bindings only when this passes: pnpm exec trestle jobs migrate --to ${to} --env ${environment} --check`,
    `Rollback: run the same steps with --to ${from}. The inbox guarantees no event completes twice, whichever runtime delivers it.`,
  ];
}
