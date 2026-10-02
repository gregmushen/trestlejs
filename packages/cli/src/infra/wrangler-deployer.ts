import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectManifest } from "../manifest.js";
import { wranglerEnvironmentBlock, wranglerStringVariable } from "../wrangler-config.js";
import type { ConsumerId } from "./consumers.js";
import type { ConsumerDeployer, ProbeResult, ProbeRunner } from "./deployment.js";

/**
 * Real host projection through Wrangler (plan P08), using the same
 * `wrangler secret bulk` path as `trestle secrets push`, and an HTTP probe of the
 * Worker's operational health route with a fresh database connection.
 */

export type CommandRunner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input: string }) => Promise<unknown>;

const APP_KEYS: Readonly<Partial<Record<ConsumerId, "worker" | "admin">>> = { worker: "worker", admin: "admin" };

export class WranglerDeployer implements ConsumerDeployer {
  constructor(
    private readonly root: string,
    private readonly manifest: ProjectManifest,
    private readonly environment: string,
    private readonly run: CommandRunner,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  /** The Worker name in the reviewed Wrangler config for this environment. */
  async target(consumer: ConsumerId): Promise<string> {
    const app = APP_KEYS[consumer];
    const appPath = app ? this.manifest.apps[app] : undefined;
    if (!appPath) throw new Error(`${consumer} has no Worker application in this project`);
    const configPath = path.join(this.root, appPath, "wrangler.jsonc");
    const source = await readFile(configPath, "utf8");
    const name = wranglerStringVariable(wranglerEnvironmentBlock(source, this.environment as Parameters<typeof wranglerEnvironmentBlock>[1]), "name");
    if (!name) throw new Error(`${configPath} has no Worker name for ${this.environment}`);
    return name;
  }

  async project(consumer: ConsumerId, target: string, values: Readonly<Record<string, string>>, marker: string): Promise<{ revision: string }> {
    const app = APP_KEYS[consumer];
    if (!app) throw new Error(`${consumer} is not a Worker consumer`);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(target)) throw new Error("unsafe Worker target name");
    // Values travel on stdin only, never in arguments.
    await this.run("pnpm", ["--filter", `@${this.manifest.project.name}/${app}`, "exec", "wrangler", "secret", "bulk", "--env", this.environment], { cwd: this.root, env: this.env, input: JSON.stringify({ ...values, TRESTLE_CREDENTIAL_GENERATION: marker }) });
    // Wrangler does not report the new version here; the marker uniquely names the deployed generation.
    return { revision: marker };
  }
}

export type HealthFetch = (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>;

export class OperationalHealthProbe implements ProbeRunner {
  constructor(
    private readonly baseUrls: Readonly<Partial<Record<ConsumerId, string>>>,
    private readonly expectedRole: string,
    private readonly fetchHealth: HealthFetch = (url) => fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }),
  ) {}

  async probe(consumer: ConsumerId): Promise<ProbeResult> {
    const base = this.baseUrls[consumer];
    if (!base || !/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/|$)/iu.test(base)) return { status: "unreachable" };
    let response: Awaited<ReturnType<HealthFetch>>;
    try {
      response = await this.fetchHealth(new URL("/api/health/operational?probe=database", base).toString());
    } catch {
      return { status: "unreachable" };
    }
    if (response.status === 429) return { status: "rate_limited" };
    if (response.status >= 500 || response.status !== 200) return { status: "error" };
    const body = await response.json().catch(() => undefined) as { credentialGeneration?: unknown; database?: { freshConnection?: unknown; role?: unknown } } | undefined;
    const generation = typeof body?.credentialGeneration === "string" ? body.credentialGeneration : null;
    const database = body?.database;
    // A failed fresh connection, or one running as anything but the restricted role, is a dependency error.
    if (!database || database.freshConnection !== true || database.role !== this.expectedRole) return { status: "error" };
    return { status: "ok", ...(generation ? { revision: generation } : {}), credentialGeneration: generation, newConnection: true };
  }
}
