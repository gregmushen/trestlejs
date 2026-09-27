import { runCommand } from "./processes.js";

export type JobRuntimeName = "cloudflare" | "trigger" | "inngest";

export type MigrationInventory = Readonly<{
  /** Committed events not yet handed to any runtime; the new owner dispatches them. */
  pending: number;
  /** Handed to a runtime inside the replay window but not completed by any consumer. */
  unconsumed: number;
  /** Dead-lettered after repeated dispatch failures, a permanent rejection, or settlement at the attempt cap; redrive them explicitly. */
  dead: number;
}>;

/** Runs the project's own outbox store (`packages/db/scripts/outbox-admin.ts`), so the queries live in one place and the CLI carries no driver. */
async function outboxAdmin(root: string, databasePackageName: string, url: string, arguments_: string[]): Promise<unknown> {
  const { stdout } = await runCommand("pnpm", ["--filter", databasePackageName, "exec", "tsx", "scripts/outbox-admin.ts", ...arguments_], { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

export async function migrationInventory(root: string, databasePackageName: string, url: string): Promise<MigrationInventory> {
  return await outboxAdmin(root, databasePackageName, url, ["migration-inventory"]) as MigrationInventory;
}

/** Re-dispatches events no consumer completed; the Worker's dispatcher sends them to the current runtime. Events at the attempt cap are dead-lettered. */
export async function settleForMigration(root: string, databasePackageName: string, url: string, olderThanMinutes: number): Promise<number> {
  return (await outboxAdmin(root, databasePackageName, url, ["migration-settle", String(olderThanMinutes)]) as { settled: number }).settled;
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
