import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const evidenceStatusSchema = z.enum(["not-started", "in-progress", "blocked", "verified"]);

const resultSchema = z.object({
  recordedAt: z.string(),
  revision: z.string(),
  /** Uncommitted changes existed when the result was recorded. */
  dirty: z.boolean(),
  environment: z.enum(["local", "preview", "staging", "production"]),
  command: z.string().optional(),
  exitCode: z.number().int().optional(),
  /** CI run, deployment, or dashboard link; required for deployed claims. */
  url: z.string().url().optional(),
  note: z.string().optional(),
}).strict();

export const evidenceClaimSchema = z.object({
  title: z.string().min(1),
  owner: z.string().min(1).optional(),
  /** local claims can be proven on a developer machine; deployed claims only by a deployed environment. */
  scope: z.enum(["local", "deployed"]),
  claim: z.string().min(1),
  proof: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  status: evidenceStatusSchema.default("not-started"),
  blockedReason: z.string().optional(),
  limitations: z.array(z.string()).default([]),
  results: z.array(resultSchema).default([]),
}).strict();

export const evidenceLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  claims: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/u), evidenceClaimSchema),
}).strict();

export type EvidenceLedger = z.output<typeof evidenceLedgerSchema>;
export type EvidenceClaim = z.output<typeof evidenceClaimSchema>;

export const ledgerPath = (root: string) => path.join(root, ".trestle", "evidence.yaml");

export async function readLedger(root: string): Promise<EvidenceLedger | undefined> {
  const source = await readFile(ledgerPath(root), "utf8").catch(() => undefined);
  if (source === undefined) return undefined;
  return evidenceLedgerSchema.parse(parseYaml(source));
}

export async function writeLedger(root: string, ledger: EvidenceLedger): Promise<void> {
  const validated = evidenceLedgerSchema.parse(ledger);
  for (const [id, claim] of Object.entries(validated.claims)) {
    const unknown = claim.dependsOn.filter((dependency) => !validated.claims[dependency]);
    if (unknown.length) throw new Error(`claim ${id} depends on unknown claims: ${unknown.join(", ")}`);
  }
  await writeFile(ledgerPath(root), `# Implementation and release evidence. Managed with \`trestle evidence\`; review changes like code.\n${stringifyYaml(validated, { lineWidth: 100 })}`, "utf8");
}

/** A starter ledger with the end-to-end claims every TrestleJS application should prove. */
export function starterLedger(): EvidenceLedger {
  return evidenceLedgerSchema.parse({
    schemaVersion: 1,
    claims: {
      "local-canary": {
        title: "End-to-end canary passes locally",
        scope: "local",
        claim: "A verified account signs in, performs a protected resource operation, is denied another tenant's data, makes an audited administrative change, and sees a background job complete.",
        proof: "pnpm --filter ./apps/worker exec vitest run src/canary.integration.test.ts with TRESTLE_SYSTEM_TEST_DATABASE_URL set",
      },
      "staging-canary": {
        title: "End-to-end canary passes on staging",
        scope: "deployed",
        dependsOn: ["local-canary"],
        claim: "The deployed staging application passes the same end-to-end journey.",
        proof: "the staging deploy workflow's browser and smoke checks, linked as a CI run URL",
      },
    },
  });
}

async function gitRevision(root: string): Promise<{ revision: string; dirty: boolean }> {
  try {
    const revision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    // The ledger records results itself, so its own changes do not make the tested revision ambiguous.
    const dirty = (await execFileAsync("git", ["status", "--porcelain", "--", ".", ":(exclude).trestle/evidence.yaml"], { cwd: root })).stdout.trim().length > 0;
    return { revision, dirty };
  } catch {
    return { revision: "unknown", dirty: true };
  }
}

async function runShell(command: string, root: string, output: (text: string) => void): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: root, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => output(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => output(chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

export type RecordInput = Readonly<{
  environment: "local" | "preview" | "staging" | "production";
  command?: string;
  url?: string;
  note?: string;
}>;

/**
 * Records a result against a claim. A command run on this machine can verify
 * only a local claim; a deployed claim needs a non-local environment and a
 * link to the deployed evidence. Every result carries the git revision, and
 * a result from a dirty tree never verifies a claim.
 */
export async function recordEvidence(root: string, id: string, input: RecordInput, output: (text: string) => void = () => {}): Promise<EvidenceClaim> {
  const ledger = await readLedger(root);
  if (!ledger) throw new Error("no .trestle/evidence.yaml; run trestle evidence init");
  const claim = ledger.claims[id];
  if (!claim) throw new Error(`unknown claim ${id}`);
  if (!input.command && !input.url) throw new Error("record a --command to run or a --url to deployed evidence");
  if (claim.scope === "deployed" && (input.environment === "local" || !input.url)) throw new Error(`${id} is a deployed claim: record it with --env <preview|staging|production> and --url to the deployed run; local success cannot establish it`);
  const { revision, dirty } = await gitRevision(root);
  const exitCode = input.command ? await runShell(input.command, root, output) : undefined;
  const result = { recordedAt: new Date().toISOString(), revision, dirty, environment: input.environment, ...(input.command ? { command: input.command, exitCode } : {}), ...(input.url ? { url: input.url } : {}), ...(input.note ? { note: input.note } : {}) };
  const unverifiedDependencies = claim.dependsOn.filter((dependency) => ledger.claims[dependency]!.status !== "verified");
  const passed = (exitCode === undefined || exitCode === 0) && !dirty && unverifiedDependencies.length === 0;
  const next: EvidenceClaim = { ...claim, results: [...claim.results, result].slice(-20), status: passed ? "verified" : exitCode !== undefined && exitCode !== 0 ? "in-progress" : claim.status === "not-started" ? "in-progress" : claim.status };
  if (passed) delete (next as { blockedReason?: string }).blockedReason;
  await writeLedger(root, { ...ledger, claims: { ...ledger.claims, [id]: next } });
  if (!passed) {
    const reasons = [
      ...(exitCode !== undefined && exitCode !== 0 ? [`the command exited ${exitCode}`] : []),
      ...(dirty ? ["the working tree has uncommitted changes, so the revision does not identify what was tested"] : []),
      ...(unverifiedDependencies.length ? [`dependencies are not verified: ${unverifiedDependencies.join(", ")}`] : []),
    ];
    throw new Error(`recorded, but ${id} is not verified: ${reasons.join("; ")}`);
  }
  return next;
}

/** A claim verified at an older revision is reported as stale, not as current proof. */
export async function evidenceReport(root: string): Promise<{ revision: string; claims: Array<{ id: string; title: string; scope: string; status: string; stale: boolean; owner?: string; lastResult?: EvidenceClaim["results"][number]; blockedReason?: string; limitations: string[] }> }> {
  const ledger = await readLedger(root);
  if (!ledger) throw new Error("no .trestle/evidence.yaml; run trestle evidence init");
  const { revision } = await gitRevision(root);
  return {
    revision,
    claims: Object.entries(ledger.claims).map(([id, claim]) => {
      const lastResult = claim.results.at(-1);
      return { id, title: claim.title, scope: claim.scope, status: claim.status, stale: claim.status === "verified" && lastResult?.revision !== revision, ...(claim.owner ? { owner: claim.owner } : {}), ...(lastResult ? { lastResult } : {}), ...(claim.blockedReason ? { blockedReason: claim.blockedReason } : {}), limitations: claim.limitations };
    }),
  };
}

export function formatEvidenceReport(report: Awaited<ReturnType<typeof evidenceReport>>): string {
  const width = Math.max(10, ...report.claims.map((claim) => claim.id.length));
  return [
    `Revision ${report.revision.slice(0, 12)}`,
    ...report.claims.map((claim) => `${claim.id.padEnd(width)}  ${claim.scope.padEnd(8)}  ${(claim.stale ? "stale" : claim.status).padEnd(11)}  ${claim.title}${claim.lastResult ? `  (${claim.lastResult.recordedAt.slice(0, 10)} at ${claim.lastResult.revision.slice(0, 8)}${claim.lastResult.url ? ` ${claim.lastResult.url}` : ""})` : ""}${claim.blockedReason ? `\n${" ".repeat(width + 2)}blocked: ${claim.blockedReason}` : ""}`),
  ].join("\n");
}
