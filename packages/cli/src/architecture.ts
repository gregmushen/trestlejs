import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { MANAGED_GUIDANCE_VERSION } from "./upgrade.js";

export type ArchitectureCheck = Readonly<{ id: string; status: "pass" | "fail"; message: string; evidence?: string }>;
export type ArchitectureReport = Readonly<{ valid: boolean; checks: readonly ArchitectureCheck[] }>;

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? files(path.join(directory, entry.name)) : /\.[cm]?[jt]sx?$/u.test(entry.name) ? [path.join(directory, entry.name)] : []))).flat();
}

function result(id: string, valid: boolean, message: string, evidence?: string): ArchitectureCheck {
  return { id, status: valid ? "pass" : "fail", message, ...(evidence ? { evidence } : {}) };
}

export async function checkArchitecture(root: string): Promise<ArchitectureReport> {
  const checks: ArchitectureCheck[] = [];
  const boundaryRoots = [path.join(root, "apps", "app", "src"), path.join(root, "packages", "domain", "src")];
  const violations: string[] = [];
  for (const target of (await Promise.all(boundaryRoots.map(files))).flat()) {
    const source = await readFile(target, "utf8");
    if (/from\s+["'](?:stripe|resend|@neondatabase\/serverless|postgres|drizzle-orm(?:\/[^"']*)?)["']/u.test(source)) violations.push(path.relative(root, target));
  }
  checks.push(result("architecture.provider-boundary", violations.length === 0, "application and domain source depend on provider-neutral boundaries", violations.join(", ") || undefined));

  const resourceDirectory = path.join(root, ".trestle", "resources");
  const declarations = (await readdir(resourceDirectory).catch(() => [])).filter((entry) => entry.endsWith(".json"));
  const migrationDirectory = path.join(root, "packages", "db", "migrations");
  const migrationFiles = (await readdir(migrationDirectory).catch(() => [])).filter((file) => file.endsWith(".sql")).map((file) => path.join(migrationDirectory, file));
  const migrations = (await Promise.all(migrationFiles.map((file) => readFile(file, "utf8")))).join("\n");
  for (const declarationFile of declarations) {
    const declaration = JSON.parse(await readFile(path.join(resourceDirectory, declarationFile), "utf8")) as { name?: string; tenant?: boolean; persistence?: { table?: string }; files?: string[] };
    const missing = (await Promise.all((declaration.files ?? []).map(async (file) => access(path.join(root, file)).then(() => undefined, () => file)))).filter((value): value is string => Boolean(value));
    checks.push(result(`architecture.resource.${declaration.name ?? declarationFile}.files`, missing.length === 0, `${declaration.name ?? declarationFile} declared source exists`, missing.join(", ") || undefined));
    const table = declaration.persistence?.table;
    const forced = !declaration.tenant || Boolean(table && new RegExp(`ALTER TABLE ["']?${table}["']? FORCE ROW LEVEL SECURITY`, "u").test(migrations));
    checks.push(result(`architecture.resource.${declaration.name ?? declarationFile}.rls`, forced, `${declaration.name ?? declarationFile} tenant table forces PostgreSQL RLS`, table));
  }
  const skill = await readFile(path.join(root, ".agents", "skills", "trestle-setup", "SKILL.md"), "utf8").catch(() => "");
  checks.push(result("architecture.guidance.managed", skill.includes(`<!-- trestle-managed-guidance:${MANAGED_GUIDANCE_VERSION} -->`), "managed setup guidance carries the current version marker"));
  return { valid: checks.every(({ status }) => status === "pass"), checks };
}

export function formatArchitecture(report: ArchitectureReport): string {
  return `${report.checks.map((check) => `${check.status === "pass" ? "✓" : "✗"} ${check.message}${check.evidence ? ` — ${check.evidence}` : ""}`).join("\n")}\n\n${report.valid ? "Architecture contract is valid." : "Architecture contract has failures."}\n`;
}
