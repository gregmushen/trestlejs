import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import os from "node:os";
import { describe, expect, it } from "vitest";

import type { ProjectManifest } from "../src/core.js";
import { formatStatus, localStatus, portConflicts, portOwner, type PortOwner, type StatusProbes } from "../src/local-status.js";

const manifest = { schemaVersion: 1, project: { name: "fixture" }, apps: { app: "apps/app", worker: "apps/worker", admin: "apps/admin" }, packages: {}, capabilities: { admin: true } } as unknown as ProjectManifest;

function probes(overrides: Partial<{ up: Record<number, number>; listeners: Record<number, PortOwner>; database: { applied: number } | { error: string } }> = {}): StatusProbes {
  const up = overrides.up ?? {};
  return {
    http: async (url) => {
      const port = Number(new URL(url).port);
      return port in up ? { status: up[port]! } : { error: "ECONNREFUSED" };
    },
    listener: async (port) => overrides.listeners?.[port],
    database: async () => overrides.database ?? { applied: 0 },
  };
}

describe("local status", () => {
  it("distinguishes healthy, starting, failed, disabled, and unconfigured services", async () => {
    const statuses = await localStatus(os.tmpdir(), manifest, { DATABASE_URL: "postgres://u:p@localhost:55432/app" }, probes({
      up: { 42069: 200, 8787: 200, 8788: 200 },
      listeners: { 42070: { port: 42070, pid: 10, command: "node", owned: true } },
      database: { applied: 3 },
    }));
    const state = Object.fromEntries(statuses.map((status) => [status.id, status.state]));
    expect(state).toMatchObject({ site: "disabled", app: "healthy", api: "healthy", admin: "starting", "admin-api": "healthy", database: "healthy", migrations: "unconfigured", "email-sink": "healthy", scheduler: "healthy", "email-provider": "healthy" });
    const noDatabase = await localStatus(os.tmpdir(), manifest, {}, probes());
    expect(noDatabase.find((status) => status.id === "database")).toMatchObject({ state: "unconfigured", repair: expect.stringContaining("secrets edit") });
    expect(noDatabase.find((status) => status.id === "app")).toMatchObject({ state: "failed", detail: "not running", repair: "pnpm exec trestle dev" });
    expect(noDatabase.find((status) => status.id === "email-sink")).toMatchObject({ state: "failed", detail: "the API is not running" });
  });

  it("names an unrelated process holding a service port and never suggests killing it silently", async () => {
    const statuses = await localStatus(os.tmpdir(), manifest, {}, probes({ listeners: { 42069: { port: 42069, pid: 99, command: "python3", cwd: "/elsewhere", owned: false } } }));
    expect(statuses.find((status) => status.id === "app")).toMatchObject({ state: "failed", detail: expect.stringContaining("python3 (pid 99) from /elsewhere, not this project"), repair: expect.stringContaining("--takeover 42069") });
    expect(formatStatus(statuses)).toContain("repair: stop pid 99");
  });

  it("does not report another project's server as this project's healthy service", async () => {
    const statuses = await localStatus(os.tmpdir(), manifest, {}, probes({ up: { 42069: 200 }, listeners: { 42069: { port: 42069, pid: 7, command: "node", cwd: "/other/project/apps/app", owned: false } } }));
    expect(statuses.find((status) => status.id === "app")).toMatchObject({ state: "failed", detail: expect.stringContaining("from /other/project/apps/app, not this project") });
  });

  it("reports migrations behind the journal", async () => {
    const root = (await import("node:fs/promises")).mkdtemp(`${os.tmpdir()}/status-`);
    const directory = await root;
    await (await import("node:fs/promises")).mkdir(`${directory}/packages/db/migrations/meta`, { recursive: true });
    await (await import("node:fs/promises")).writeFile(`${directory}/packages/db/migrations/meta/_journal.json`, JSON.stringify({ entries: [{}, {}, {}] }));
    const statuses = await localStatus(directory, manifest, { DATABASE_URL: "postgres://u:p@localhost:55432/app" }, probes({ database: { applied: 2 } }));
    expect(statuses.find((status) => status.id === "migrations")).toMatchObject({ state: "failed", detail: "2 of 3 applied", repair: "pnpm exec trestle db migrate" });
  });

  it("lists every declared development port another process holds", async () => {
    const conflicts = await portConflicts(manifest, async (port) => port === 8787 ? { port, pid: 5, command: "workerd", owned: true } : undefined);
    expect(conflicts).toEqual([{ port: 8787, pid: 5, command: "workerd", owned: true, service: "api" }]);
  });

  const hasLsof = (() => { try { execFileSync("lsof", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();
  it.skipIf(!hasLsof)("identifies a real listener and whether it runs from the project", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await portOwner(port, process.cwd())).toMatchObject({ port, pid: process.pid, owned: true });
      expect(await portOwner(port, "/definitely/not/this/project")).toMatchObject({ pid: process.pid, owned: false });
    } finally {
      server.close();
    }
    expect(await portOwner(port, process.cwd())).toBeUndefined();
  });
});
