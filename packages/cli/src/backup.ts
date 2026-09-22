import { readFile } from "node:fs/promises";
import path from "node:path";

export type RecoveryPolicy = Readonly<{ schemaVersion: 1; provider: "neon"; sourceBranch: string; restoreTargets: readonly string[]; recoveryPointObjectiveHours: number; recoveryTimeObjectiveMinutes: number; artifactPolicy: "metadata-reference-verification" | "none" }>;
export type RecoveryConnectionOutput = Readonly<{ branchId: string; migrationUrl: string; runtimeUrl: string }>;

export async function readRecoveryPolicy(root: string): Promise<RecoveryPolicy> {
  const value = JSON.parse(await readFile(path.join(root, ".trestle", "recovery.json"), "utf8")) as Partial<RecoveryPolicy>;
  if (value.schemaVersion !== 1 || value.provider !== "neon" || !validName(value.sourceBranch) || !Array.isArray(value.restoreTargets) || value.restoreTargets.length === 0 || value.restoreTargets.some((target) => !validName(target) || target === value.sourceBranch) || !positive(value.recoveryPointObjectiveHours) || !positive(value.recoveryTimeObjectiveMinutes) || !["metadata-reference-verification", "none"].includes(value.artifactPolicy ?? "")) throw new Error("invalid .trestle/recovery.json policy");
  return value as RecoveryPolicy;
}

export function validateRecoveryTarget(policy: RecoveryPolicy, target: string): string {
  if (!policy.restoreTargets.includes(target)) throw new Error(`restore target ${target} is not declared by recovery policy`);
  if (target === policy.sourceBranch || /^(?:main|production|prod)$/iu.test(target)) throw new Error("restore target must be isolated from the source and production");
  return target;
}

export function validateRecoveryPoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date > new Date()) throw new Error("recovery point must be a valid past ISO timestamp");
  return date.toISOString();
}

export function parseRecoveryConnectionOutput(source: string): RecoveryConnectionOutput {
  const values = Object.fromEntries(source.split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("invalid protected recovery output");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const branchId = values.branch_id;
  const migrationUrl = values.migration_url;
  const runtimeUrl = values.runtime_url;
  if (!branchId || !/^[a-z0-9-]+$/iu.test(branchId) || !validPostgresUrl(migrationUrl) || !validPostgresUrl(runtimeUrl)) throw new Error("protected recovery output is incomplete");
  return { branchId, migrationUrl, runtimeUrl };
}

function validPostgresUrl(value: unknown): value is string {
  if (typeof value !== "string" || /[\r\n]/u.test(value)) return false;
  try { return ["postgres:", "postgresql:"].includes(new URL(value).protocol); } catch { return false; }
}

function validName(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
