import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ProjectManifest } from "./core.js";

const run = promisify(execFile);

export type ServiceState = "disabled" | "unconfigured" | "starting" | "healthy" | "failed";
export type ServiceStatus = Readonly<{ id: string; label: string; state: ServiceState; url?: string; detail: string; repair?: string }>;
export type PortOwner = Readonly<{ port: number; pid: number; command: string; cwd?: string; owned: boolean }>;

/** The fixed local development ports `trestle dev` binds. */
export function developmentPorts(manifest: ProjectManifest): ReadonlyArray<Readonly<{ port: number; service: string }>> {
  return [
    ...(manifest.apps.site ? [{ port: 42068, service: "site" }] : []),
    { port: 42069, service: "app" },
    { port: 8787, service: "api" },
    ...(manifest.apps.admin ? [{ port: 42070, service: "admin" }, { port: 8788, service: "admin-api" }] : []),
  ];
}

export type StatusProbes = Readonly<{
  http(url: string): Promise<{ status: number; body?: unknown } | { error: string }>;
  listener(port: number): Promise<PortOwner | undefined>;
  database(url: string): Promise<{ applied: number } | { error: string }>;
}>;

/** Which process listens on a port, and whether it runs from this project (lsof; absent on some systems). */
export async function portOwner(port: number, root: string): Promise<PortOwner | undefined> {
  let listing: string;
  try {
    listing = (await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"])).stdout;
  } catch {
    return undefined;
  }
  const pid = Number(/^p(\d+)$/mu.exec(listing)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const command = /^c(.+)$/mu.exec(listing)?.[1] ?? "unknown";
  let cwd: string | undefined;
  try {
    cwd = /^n(.+)$/mu.exec((await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])).stdout)?.[1];
  } catch {
    cwd = undefined;
  }
  const resolvedRoot = path.resolve(root);
  return { port, pid, command, ...(cwd ? { cwd } : {}), owned: Boolean(cwd && (cwd === resolvedRoot || cwd.startsWith(`${resolvedRoot}${path.sep}`))) };
}

export function defaultProbes(root: string, databasePackage = "packages/db"): StatusProbes {
  return {
    async http(url) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000), headers: { accept: "application/json, text/html" } });
        const body = response.headers.get("content-type")?.includes("json") ? await response.json().catch(() => undefined) : undefined;
        return { status: response.status, body };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    listener: (port) => portOwner(port, root),
    async database(url) {
      // The project's own postgres client, so the CLI carries no database driver.
      const script = `const postgres = require("postgres"); const sql = postgres(process.env.TRESTLE_STATUS_DATABASE_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
(async () => { let applied = 0; await sql\`select 1\`; try { applied = (await sql\`select count(*)::int as count from drizzle.__drizzle_migrations\`)[0].count; } catch {} process.stdout.write(JSON.stringify({ applied })); })()
  .catch((error) => process.stdout.write(JSON.stringify({ error: error.message }))).finally(() => sql.end({ timeout: 1 }));`;
      try {
        const { stdout } = await run(process.execPath, ["-e", script], { cwd: path.join(root, databasePackage), env: { ...process.env, TRESTLE_STATUS_DATABASE_URL: url }, timeout: 10_000 });
        return JSON.parse(stdout) as { applied: number } | { error: string };
      } catch (error) {
        return { error: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
      }
    },
  };
}

async function journalEntries(root: string, manifest: ProjectManifest): Promise<number | undefined> {
  const journal = path.join(root, manifest.packages.db ?? "packages/db", "migrations", "meta", "_journal.json");
  try {
    return (JSON.parse(await readFile(journal, "utf8")) as { entries: unknown[] }).entries.length;
  } catch {
    return undefined;
  }
}

async function httpService(probes: StatusProbes, id: string, label: string, port: number, pathname: string): Promise<ServiceStatus> {
  const url = `http://localhost:${port}${pathname}`;
  const owner = await probes.listener(port);
  // A healthy answer from another project's server is not this project's service.
  if (owner && !owner.owned && owner.cwd) return { id, label, state: "failed", url, detail: `port ${port} is served by ${owner.command} (pid ${owner.pid}) from ${owner.cwd}, not this project`, repair: `stop pid ${owner.pid}, or run trestle dev --takeover ${port}` };
  const result = await probes.http(url);
  if ("status" in result && result.status < 500) return { id, label, state: "healthy", url, detail: `HTTP ${result.status}` };
  if (!owner) return { id, label, state: "failed", url, detail: "not running", repair: "pnpm exec trestle dev" };
  if (!owner.owned) return { id, label, state: "failed", url, detail: `port ${port} is held by ${owner.command} (pid ${owner.pid}) outside this project`, repair: `stop pid ${owner.pid}, or run trestle dev --takeover ${port}` };
  return { id, label, state: "starting", url, detail: "error" in result ? `listening but not answering yet (${result.error})` : `listening, HTTP ${result.status}` };
}

/**
 * Local development health for every service `trestle dev` runs, plus the
 * database, migrations, and configured providers. Read-only.
 */
export async function localStatus(root: string, manifest: ProjectManifest, environment: NodeJS.ProcessEnv, probes: StatusProbes = defaultProbes(root, manifest.packages.db ?? "packages/db")): Promise<ServiceStatus[]> {
  const statuses: ServiceStatus[] = [];
  statuses.push(manifest.apps.site ? await httpService(probes, "site", "Site", 42068, "/") : { id: "site", label: "Site", state: "disabled", detail: "apps.site is not enabled" });
  statuses.push(await httpService(probes, "app", "App", 42069, "/"));
  const api = await httpService(probes, "api", "API", 8787, "/api/health");
  statuses.push(api);
  if (manifest.apps.admin && manifest.capabilities.admin) {
    statuses.push(await httpService(probes, "admin", "Admin", 42070, "/"));
    statuses.push(await httpService(probes, "admin-api", "Admin API", 8788, "/api/admin/health/live"));
  } else {
    statuses.push({ id: "admin", label: "Admin", state: "disabled", detail: "capabilities.admin is false" });
  }

  const databaseUrl = environment.DATABASE_MIGRATION_URL ?? environment.DATABASE_URL;
  if (!databaseUrl) {
    statuses.push({ id: "database", label: "Database", state: "unconfigured", detail: "DATABASE_URL is not set in local credentials", repair: "pnpm exec trestle secrets edit --env local" });
  } else {
    const database = await probes.database(databaseUrl);
    const expected = await journalEntries(root, manifest);
    if ("error" in database) {
      statuses.push({ id: "database", label: "Database", state: "failed", detail: database.error, repair: "pnpm exec trestle dev" });
      statuses.push({ id: "migrations", label: "Migrations", state: "failed", detail: "database unreachable" });
    } else {
      statuses.push({ id: "database", label: "Database", state: "healthy", detail: new URL(databaseUrl).host });
      statuses.push(expected === undefined ? { id: "migrations", label: "Migrations", state: "unconfigured", detail: "no migration journal" }
        : database.applied >= expected ? { id: "migrations", label: "Migrations", state: "healthy", detail: `${database.applied} of ${expected} applied` }
          : { id: "migrations", label: "Migrations", state: "failed", detail: `${database.applied} of ${expected} applied`, repair: "pnpm exec trestle db migrate" });
    }
  }

  for (const [id, label, pathname] of [["email-sink", "Email sink", "/api/dev/emails"], ["scheduler", "Scheduler", "/api/dev/scheduler"]] as const) {
    if (api.state !== "healthy") {
      statuses.push({ id, label, state: "failed", detail: "the API is not running", repair: "pnpm exec trestle dev" });
      continue;
    }
    const result = await probes.http(`http://localhost:8787${pathname}`);
    statuses.push("status" in result && result.status < 400
      ? { id, label, state: "healthy", url: `http://localhost:8787${pathname}`, detail: `HTTP ${result.status}` }
      : { id, label, state: "failed", url: `http://localhost:8787${pathname}`, detail: "error" in result ? result.error : `HTTP ${result.status}` });
  }

  statuses.push(environment.RESEND_API_KEY
    ? { id: "email-provider", label: "Email provider", state: "healthy", detail: "RESEND_API_KEY present (credentials or shell environment)" }
    : { id: "email-provider", label: "Email provider", state: "healthy", detail: "local capture (no Resend key)" });
  statuses.push(environment.STRIPE_SECRET_KEY
    ? { id: "billing-provider", label: "Billing provider", state: "healthy", detail: `Stripe ${environment.STRIPE_SECRET_KEY.startsWith("sk_live_") ? "live" : "test"} credentials present` }
    : { id: "billing-provider", label: "Billing provider", state: "healthy", detail: "local billing adapter (no Stripe key)" });
  return statuses;
}

export function formatStatus(statuses: readonly ServiceStatus[]): string {
  const width = Math.max(...statuses.map((status) => status.label.length));
  return statuses.map((status) => `${status.label.padEnd(width)}  ${status.state.padEnd(12)}  ${status.url ? `${status.url}  ` : ""}${status.detail}${status.repair ? `\n${" ".repeat(width + 16)}repair: ${status.repair}` : ""}`).join("\n");
}

/**
 * Ports `trestle dev` needs that another process already holds. Processes from
 * this project may be reclaimed; unrelated listeners are only stopped for
 * ports named explicitly with --takeover.
 */
export async function portConflicts(manifest: ProjectManifest, listener: (port: number) => Promise<PortOwner | undefined>): Promise<Array<PortOwner & { service: string }>> {
  const conflicts: Array<PortOwner & { service: string }> = [];
  for (const { port, service } of developmentPorts(manifest)) {
    const owner = await listener(port);
    if (owner) conflicts.push({ ...owner, service });
  }
  return conflicts;
}
