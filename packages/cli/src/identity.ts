import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { transactionTestSchema, type EnvironmentName, type EvidenceDocument, type ProjectManifest, type TransactionTest } from "@trestlejs/core";

import { readEvidence, writeEvidence } from "./capabilities.js";
import { runCommand } from "./processes.js";
import { CliFailure } from "./runtime.js";
import { readSecrets } from "./secrets.js";

export type ScimTransactionResult = TransactionTest;

/** The generated project's provisioning run: real SCIM create/update/deactivate calls through Better Auth. */
export const SCIM_TRANSACTION_SCRIPT = "src/scim-transactions.ts";

/**
 * Runs the transaction compatibility test against the environment's own
 * database and driver, then records the non-secret result as evidence.
 * Credentials reach the child process through its environment only.
 */
export async function verifyScimTransactions(
  root: string,
  manifest: ProjectManifest,
  environment: EnvironmentName,
  masterKey: string | undefined,
  run: typeof runCommand = runCommand,
  now: () => Date = () => new Date(),
): Promise<ScimTransactionResult> {
  if (manifest.identity?.directory !== "better-auth-scim") throw new CliFailure("identity.directory is not better-auth-scim; there is no self-hosted SCIM to verify");
  const values = await readSecrets(root, environment, masterKey);
  if (!values.DATABASE_URL) throw new CliFailure(`DATABASE_URL is missing for ${environment}`);
  const driver = values.DATABASE_DRIVER || "neon-http";
  const directory = await mkdtemp(path.join(os.tmpdir(), "trestle-scim-"));
  const output = path.join(directory, "result.json");
  let result: ScimTransactionResult;
  try {
    await run("pnpm", ["--filter", `./${manifest.packages.auth ?? "packages/auth"}`, "exec", "tsx", SCIM_TRANSACTION_SCRIPT], {
      cwd: root,
      stdio: "pipe",
      env: {
        ...process.env,
        APP_ENV: environment,
        DATABASE_URL: values.DATABASE_URL,
        DATABASE_DRIVER: driver,
        BETTER_AUTH_SECRET: values.BETTER_AUTH_SECRET || "scim-transaction-test-secret-not-for-sessions",
        BETTER_AUTH_URL: values.BETTER_AUTH_URL || "http://localhost:42069",
        TRESTLE_SCIM_RESULT: output,
      },
    }).catch(() => undefined);
    const parsed = transactionTestSchema.safeParse(JSON.parse(await readFile(output, "utf8").catch(() => "null")));
    result = parsed.success && parsed.data.driver === driver ? parsed.data
      : { driver, passed: false, operations: [], checkedAt: now().toISOString(), failure: "The transaction test did not produce a result; run it directly to see the error" };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const previous = await readEvidence(root, environment);
  const evidence: EvidenceDocument = previous
    ? { ...previous, scimTransactions: result }
    : { schemaVersion: 1, environment, recordedAt: result.checkedAt, capabilities: {}, scimTransactions: result };
  await writeEvidence(root, evidence);
  return result;
}

export function formatScimResult(environment: EnvironmentName, result: ScimTransactionResult): string {
  return result.passed
    ? `✓ SCIM provisioning transactions passed on ${result.driver} (${environment}): ${result.operations.join(", ")}\n`
    : `✗ SCIM provisioning transactions failed on ${result.driver} (${environment})\n  ${result.failure ?? "unknown failure"}\n  Fix: use a driver with interactive transactions (DATABASE_DRIVER=postgres-js), then rerun trestle identity verify-scim --env ${environment}\n`;
}
