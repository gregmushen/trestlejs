import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { commitSnapshot, mergeProviderValues, parseDotenv, readCommittedSnapshot, type CredentialMetadata } from "./credentials.js";
import { validatePostgresEndpoint } from "./endpoints.js";
import { redact } from "./redaction.js";
import type { OperationStore } from "./store.js";

/**
 * Connects a Projects-provisioned Neon database to the application's own
 * Drizzle pipeline (spec §20–§21): migrate and configure roles with the
 * operator-only owner credential, then derive, verify and commit only the
 * restricted runtime credential to the deployment snapshot.
 */

export type ScriptRunner = (command: string, args: readonly string[], options: { cwd: string; env: Readonly<Record<string, string>> }) => Promise<void>;

export type DatabaseSetupInput = Readonly<{
  root: string;
  store: OperationStore;
  masterKey: string;
  projectId: string;
  environment: string;
  /** Logical resource name; the owner output is `<NAME>_CONNECTION_STRING`. */
  resource: string;
  externalId: string;
  runtimeRole: string;
  consumers: readonly ("worker" | "admin")[];
  run: ScriptRunner;
  /** Directories needed to find node and pnpm; nothing else from the operator environment is passed. */
  path: string;
  now: () => Date;
}>;

export type DatabaseSetupResult = Readonly<{ operationId: string; deploymentGeneration: number; runtimeRole: string; host: string }>;

export class DatabaseSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseSetupError";
  }
}

export function ownerOutput(resource: string): string {
  return `${resource.toUpperCase().replace(/-/gu, "_")}_CONNECTION_STRING`;
}

export async function setupDatabase(input: DatabaseSetupInput): Promise<DatabaseSetupResult> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(input.runtimeRole) || input.runtimeRole === "neondb_owner") throw new DatabaseSetupError("runtime role must be a lowercase PostgreSQL identifier other than the owner");
  const operator = await readCommittedSnapshot(input.store, { projectId: input.projectId, environment: input.environment, purpose: "operator" }, input.masterKey);
  const owner = operator.values[ownerOutput(input.resource)];
  if (!owner) throw new DatabaseSetupError(`the operator snapshot has no ${ownerOutput(input.resource)}; apply the infrastructure plan first`);
  const ownerCheck = validatePostgresEndpoint(owner, "neon");
  if (!ownerCheck.ok) throw new DatabaseSetupError(`owner endpoint rejected: ${ownerCheck.reason}`);

  const operationId = `op-db-setup-${input.environment}-${input.resource}-${input.now().getTime()}`;
  await input.store.createOperation({ id: operationId, environment: input.environment, planDigest: `database-setup:${input.resource}`, approvalId: null, state: "running" }, input.now());
  const journal = (kind: string, data: Record<string, unknown> = {}) => input.store.appendEvent(operationId, `infra.database.${kind}`, { resource: input.resource, ...data }, input.now());

  // Application scripts get a scratch HOME and only database credentials: no Stripe or provider session.
  const scratch = await mkdtemp(path.join(os.tmpdir(), "trestle-db-setup-"));
  const base = { PATH: input.path, HOME: scratch, NODE_ENV: "production", DATABASE_DRIVER: "postgres-js" };
  const exec = (operation: string, env: Record<string, string>) => input.run("pnpm", ["--filter", "./packages/db", "exec", "tsx", "scripts/runtime-role.ts", operation], { cwd: input.root, env: { ...base, ...env } });
  try {
    await journal("migrate.started");
    await input.run("pnpm", ["db:migrate"], { cwd: input.root, env: { ...base, DATABASE_URL: owner } });
    await journal("migrate.completed");

    const output = path.join(scratch, "runtime-output");
    await exec("bootstrap-managed", { DATABASE_MIGRATION_URL: owner, DATABASE_RUNTIME_ROLE: input.runtimeRole, TRESTLE_RUNTIME_OUTPUT: output });
    await exec("configure", { DATABASE_MIGRATION_URL: owner, DATABASE_RUNTIME_ROLE: input.runtimeRole });
    const runtimeUrl = parseDotenv((await readFile(output, "utf8")).replace(/^runtime_url=/mu, "RUNTIME_URL=")).RUNTIME_URL;
    if (!runtimeUrl) throw new DatabaseSetupError("role bootstrap did not produce a runtime connection");
    const runtimeCheck = validatePostgresEndpoint(runtimeUrl, "neon");
    if (!runtimeCheck.ok || runtimeCheck.host !== ownerCheck.host) throw new DatabaseSetupError("derived runtime endpoint does not match the provisioned database");
    if (decodeURIComponent(new URL(runtimeUrl).username) !== input.runtimeRole) throw new DatabaseSetupError("derived runtime connection does not use the runtime role");
    // verify fails unless the role is restricted (no BYPASSRLS, no superuser) and tenant data access works.
    await exec("verify", { DATABASE_URL: runtimeUrl, DATABASE_RUNTIME_ROLE: input.runtimeRole });
    await journal("roles.verified", { runtimeRole: input.runtimeRole });

    const scope = { projectId: input.projectId, environment: input.environment, purpose: "deployment" as const };
    const current = await readCommittedSnapshot(input.store, scope, input.masterKey);
    const metadata: CredentialMetadata = { name: "DATABASE_URL", classification: "provider-managed", binding: `${input.resource}-runtime`, provider: "neon", resource: input.externalId, consumers: [...input.consumers], importedAt: input.now().toISOString(), override: false };
    const merged = mergeProviderValues(current, { values: { DATABASE_URL: runtimeUrl }, metadata: [metadata] });
    if (merged.status === "conflict") throw new DatabaseSetupError(merged.conflicts.join("; "));
    const generation = await commitSnapshot(input.store, scope, current.generation, merged.values, merged.metadata, input.masterKey);
    await journal("runtime.committed", { deploymentGeneration: generation, consumers: [...input.consumers] });
    await input.store.setOperationState(operationId, "succeeded", input.now());
    return { operationId, deploymentGeneration: generation, runtimeRole: input.runtimeRole, host: runtimeCheck.host };
  } catch (error) {
    await journal("failed", { reason: error instanceof Error ? redact(error.message).slice(0, 200) : "error" });
    await input.store.setOperationState(operationId, "needs_intervention", input.now());
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
