import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundledTemplateRoot = path.join(moduleDirectory, "template");
const defaultTemplateRoot = existsSync(bundledTemplateRoot) ? bundledTemplateRoot : path.join(moduleDirectory, "..", "..", "create", "template");
const migrationPath = path.join("packages", "db", "migrations");

export type MigrationCorrection = Readonly<{ published: string; corrected: string; reason: string }>;

/**
 * Published migrations are never rewritten, except for a reviewed correction
 * whose old bytes could only have been applied with the same resulting database
 * state. The audit accepts exactly those published bytes as the corrected file,
 * and `trestle upgrade apply` replaces them so later deploys use the fix.
 */
export const REVIEWED_MIGRATION_CORRECTIONS: Readonly<Record<string, MigrationCorrection>> = {
  "0033_jazzy_lilith": {
    published: "ec5220b73db0f2a8350fefaba29ccdebb27174d0ad9b55f267042a534eadd026",
    corrected: "620ec2f75f5c1ca917b3731a28c78be0c94ba35b4cee6da804a7353f4740252a",
    reason: "0.1.0-beta.3 granted EXECUTE on the retention functions after revoking the migration role's temporary membership, so a non-superuser migration role (such as Neon's database owner) could not apply it; a superuser applying it reaches the same state as the correction",
  },
};

type Migration = Readonly<{ index: number; tag: string; when: number; version: string; checksum: string }>;
type Journal = Readonly<{ version: string; dialect: string; migrations: readonly Migration[] }>;
export type MigrationAudit = Readonly<{
  classification: "matching" | "target-ahead" | "application-ahead" | "diverged" | "invalid";
  commonPrefix: number;
  applicationCount: number;
  targetCount: number;
  firstDifference: Readonly<{ index: number; application: string | null; target: string | null; reason: "tag" | "timestamp" | "version" | "sql" | "append" }> | null;
  applicationTail: readonly string[];
  targetTail: readonly string[];
  /** Application migrations still carrying published bytes that have a reviewed correction. */
  corrections: readonly string[];
  issues: readonly string[];
  requiresReview: boolean;
}>;

async function safeFile(root: string, relative: string): Promise<Buffer> {
  let current = root;
  const segments = relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`unsafe migration path: ${relative}`);
    }
    if (stat.isFile() && stat.size > 4 * 1024 * 1024) throw new Error(`migration file exceeds 4 MiB: ${relative}`);
  }
  return readFile(current);
}

async function loadJournal(root: string): Promise<Journal> {
  const source = await safeFile(root, path.join(migrationPath, "meta", "_journal.json"));
  const value: unknown = JSON.parse(source.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid migration journal");
  const journal = value as Record<string, unknown>;
  if (journal.dialect !== "postgresql" || typeof journal.version !== "string" || !Array.isArray(journal.entries) || journal.entries.length > 10_000) {
    throw new Error("invalid PostgreSQL migration journal");
  }
  const migrations: Migration[] = [];
  const tags = new Set<string>();
  for (const [index, raw] of journal.entries.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`invalid journal entry ${index}`);
    const entry = raw as Record<string, unknown>;
    if (entry.idx !== index || typeof entry.tag !== "string" || !/^[0-9]{4,}_[A-Za-z0-9_-]+$/u.test(entry.tag)
      || tags.has(entry.tag) || !Number.isSafeInteger(entry.when) || Number(entry.when) < 0 || typeof entry.version !== "string") {
      throw new Error(`invalid journal entry ${index}`);
    }
    tags.add(entry.tag);
    const sql = await safeFile(root, path.join(migrationPath, `${entry.tag}.sql`));
    migrations.push({ index, tag: entry.tag, when: Number(entry.when), version: entry.version, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  const directory = path.join(root, migrationPath);
  const sqlFiles = (await readdir(directory)).filter((name) => name.endsWith(".sql"));
  const unjournaled = sqlFiles.filter((name) => !tags.has(name.slice(0, -4)));
  if (unjournaled.length) throw new Error(`unjournaled SQL files: ${unjournaled.slice(0, 10).join(", ")}`);
  return { version: journal.version, dialect: journal.dialect, migrations };
}

/** Read-only journal and SQL identity audit. It cannot prove that two different
 * migration chains produce the same physical database schema. */
export async function auditMigrations(applicationRoot: string, templateRoot = defaultTemplateRoot, reviewedCorrections = REVIEWED_MIGRATION_CORRECTIONS): Promise<MigrationAudit> {
  const issues: string[] = [];
  let application: Journal | undefined;
  let target: Journal | undefined;
  try { application = await loadJournal(applicationRoot); }
  catch (error) { issues.push(`application: ${error instanceof Error ? error.message : String(error)}`); }
  try { target = await loadJournal(templateRoot); }
  catch (error) { issues.push(`target: ${error instanceof Error ? error.message : String(error)}`); }
  if (!application || !target) {
    return { classification: "invalid", commonPrefix: 0, applicationCount: application?.migrations.length ?? 0, targetCount: target?.migrations.length ?? 0,
      firstDifference: null, applicationTail: [], targetTail: [], corrections: [], issues, requiresReview: true };
  }
  if (application.version !== target.version || application.dialect !== target.dialect) {
    issues.push("journal format version or dialect differs");
  }
  let commonPrefix = 0;
  const corrections: string[] = [];
  while (commonPrefix < application.migrations.length && commonPrefix < target.migrations.length) {
    const left = application.migrations[commonPrefix]!;
    const right = target.migrations[commonPrefix]!;
    const correction = reviewedCorrections[right.tag];
    const corrected = left.tag === right.tag && correction?.published === left.checksum && correction.corrected === right.checksum;
    if (left.tag !== right.tag || left.when !== right.when || left.version !== right.version || (left.checksum !== right.checksum && !corrected)) break;
    if (corrected) corrections.push(left.tag);
    commonPrefix += 1;
  }
  const applicationTail = application.migrations.slice(commonPrefix).map(({ tag }) => tag);
  const targetTail = target.migrations.slice(commonPrefix).map(({ tag }) => tag);
  const left = application.migrations[commonPrefix];
  const right = target.migrations[commonPrefix];
  const reason = !left || !right ? "append" : left.tag !== right.tag ? "tag" : left.when !== right.when ? "timestamp" : left.version !== right.version ? "version" : "sql";
  const classification = issues.length ? "invalid" : !applicationTail.length && !targetTail.length ? "matching"
    : !applicationTail.length ? "target-ahead" : !targetTail.length ? "application-ahead" : "diverged";
  return { classification, commonPrefix, applicationCount: application.migrations.length, targetCount: target.migrations.length,
    firstDifference: !applicationTail.length && !targetTail.length ? null : { index: commonPrefix, application: applicationTail[0] ?? null, target: targetTail[0] ?? null, reason },
    applicationTail, targetTail, corrections, issues, requiresReview: classification !== "matching" };
}

/** Application migrations whose bytes are exactly a reviewed correction's published version. */
export async function findMigrationCorrections(applicationRoot: string, reviewedCorrections = REVIEWED_MIGRATION_CORRECTIONS): Promise<string[]> {
  const found: string[] = [];
  for (const [tag, correction] of Object.entries(reviewedCorrections)) {
    const source = await safeFile(applicationRoot, path.join(migrationPath, `${tag}.sql`)).catch(() => undefined);
    if (source && createHash("sha256").update(source).digest("hex") === correction.published) found.push(tag);
  }
  return found;
}

/** Replace published bytes with the reviewed correction, verifying both hashes first. */
export async function applyMigrationCorrections(applicationRoot: string, templateRoot = defaultTemplateRoot, reviewedCorrections = REVIEWED_MIGRATION_CORRECTIONS): Promise<string[]> {
  const replacements: Array<{ relative: string; source: Buffer }> = [];
  for (const tag of await findMigrationCorrections(applicationRoot, reviewedCorrections)) {
    const relative = path.join(migrationPath, `${tag}.sql`);
    const source = await safeFile(templateRoot, relative);
    if (createHash("sha256").update(source).digest("hex") !== reviewedCorrections[tag]!.corrected) {
      throw new Error(`The template's corrected migration ${tag} does not match its reviewed checksum`);
    }
    replacements.push({ relative, source });
  }
  for (const { relative, source } of replacements) await writeFile(path.join(applicationRoot, relative), source);
  return replacements.map(({ relative }) => relative);
}

export function formatMigrationAudit(report: MigrationAudit): string {
  const lines = [`Migration journal: ${report.classification}`, `${report.commonPrefix} identical entries; application ${report.applicationCount}, target ${report.targetCount}.`];
  if (report.firstDifference) lines.push(`First difference at index ${report.firstDifference.index} (${report.firstDifference.reason}): application ${report.firstDifference.application ?? "none"}, target ${report.firstDifference.target ?? "none"}.`);
  lines.push(...report.issues.map((issue) => `! ${issue}`));
  lines.push(report.requiresReview ? "Review the application migration chain and replay it against an isolated database. This audit never rewrites journal history or proves schema equivalence." : "Journal entries and SQL checksums match. This audit does not prove deployed migration state.");
  return `${lines.join("\n")}\n`;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Three-way merge of Drizzle schema snapshots: application changes since the
 * common base are laid over the target. Both sides changing the same value
 * differently is a conflict, reported by path; nothing is guessed.
 */
export function mergeSnapshots(base: JsonValue | undefined, application: JsonValue | undefined, target: JsonValue | undefined, at = "$", conflicts: string[] = []): JsonValue | undefined {
  if (same(application, target)) return application;
  if (same(base, application)) return target;
  if (same(base, target)) return application;
  const isObject = (value: unknown): value is Record<string, JsonValue> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (isObject(application) && isObject(target) && (base === undefined || isObject(base))) {
    const merged: Record<string, JsonValue> = {};
    for (const key of new Set([...Object.keys(application), ...Object.keys(target)])) {
      const value = mergeSnapshots((base as Record<string, JsonValue> | undefined)?.[key], application[key], target[key], `${at}.${key}`, conflicts);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  conflicts.push(at);
  return application;
}

export type MigrationRebase = Readonly<{ adopted: readonly string[]; moved: ReadonlyArray<Readonly<{ from: string; to: string }>> }>;

const pad = (index: number) => String(index).padStart(4, "0");

/**
 * Resolves a diverged journal where the application generated migrations after
 * the last shared release and the target added its own: adopts the target's new
 * migrations unchanged, then renumbers the application's after them. SQL bytes
 * and journal timestamps are kept, so a database that already applied an
 * application migration still recognizes it; snapshots are three-way merged so
 * the next `db:generate` diffs against the combined schema. Databases that
 * applied application migrations before the target's are caught up with
 * `pnpm db:migrate -- --apply-skipped`, never silently.
 */
export async function rebaseMigrations(applicationRoot: string, templateRoot = defaultTemplateRoot): Promise<MigrationRebase> {
  const audit = await auditMigrations(applicationRoot, templateRoot);
  if (audit.classification === "matching" || audit.classification === "application-ahead") return { adopted: [], moved: [] };
  if (audit.classification !== "diverged" && audit.classification !== "target-ahead") throw new Error(`The migration journal is ${audit.classification}; resolve it manually: ${audit.issues.join("; ")}`);
  const directory = path.join(applicationRoot, migrationPath);
  const templateDirectory = path.join(templateRoot, migrationPath);
  const readJson = async (root: string, relative: string) => JSON.parse((await safeFile(root, path.join(migrationPath, relative))).toString("utf8")) as Record<string, JsonValue>;
  const applicationJournal = await readJson(applicationRoot, "meta/_journal.json") as { entries: Array<Record<string, JsonValue>> } & Record<string, JsonValue>;
  const targetJournal = await readJson(templateRoot, "meta/_journal.json") as { entries: Array<Record<string, JsonValue>> };
  const prefix = audit.commonPrefix;
  const targetCount = targetJournal.entries.length;
  const tail = applicationJournal.entries.slice(prefix);
  const base = prefix > 0 ? await readJson(applicationRoot, `meta/${pad(prefix - 1)}_snapshot.json`) : undefined;
  const targetLast = await readJson(templateRoot, `meta/${pad(targetCount - 1)}_snapshot.json`);

  const moved: Array<{ from: string; to: string; entry: Record<string, JsonValue>; sql: Buffer; snapshot: Record<string, JsonValue> }> = [];
  let previousId = targetLast.id as string;
  const conflicts: string[] = [];
  for (const [offset, entry] of tail.entries()) {
    const from = entry.tag as string;
    const index = targetCount + offset;
    const to = `${pad(index)}_${from.slice(from.indexOf("_") + 1)}`;
    const snapshot = await readJson(applicationRoot, `meta/${pad(prefix + offset)}_snapshot.json`);
    // Snapshot identity is rewritten below; only the schema is merged.
    const schema = ({ id: _id, prevId: _prevId, ...rest }: Record<string, JsonValue>) => rest;
    const merged = mergeSnapshots(base ? schema(base) : undefined, schema(snapshot), schema(targetLast), `${from}`, conflicts) as Record<string, JsonValue>;
    moved.push({ from, to, entry: { ...entry, idx: index, tag: to }, sql: await safeFile(applicationRoot, path.join(migrationPath, `${from}.sql`)), snapshot: { ...merged, id: snapshot.id!, prevId: previousId } });
    previousId = snapshot.id as string;
  }
  if (conflicts.length) throw new Error(`Application and framework migrations change the same schema values; resolve by hand: ${conflicts.slice(0, 10).join(", ")}`);

  const adopted: string[] = [];
  for (const entry of targetJournal.entries.slice(prefix)) {
    const tag = entry.tag as string;
    const index = entry.idx as number;
    await writeFile(path.join(directory, `${tag}.sql`), await safeFile(templateRoot, path.join(migrationPath, `${tag}.sql`)));
    await writeFile(path.join(directory, "meta", `${pad(index)}_snapshot.json`), await readFile(path.join(templateDirectory, "meta", `${pad(index)}_snapshot.json`)));
    adopted.push(tag);
  }
  const { rm } = await import("node:fs/promises");
  for (const migration of moved) if (!adopted.includes(migration.from)) await rm(path.join(directory, `${migration.from}.sql`));
  for (const migration of moved) {
    await writeFile(path.join(directory, `${migration.to}.sql`), migration.sql);
    await writeFile(path.join(directory, "meta", `${pad(migration.entry.idx as number)}_snapshot.json`), `${JSON.stringify(migration.snapshot, null, 2)}\n`);
  }
  applicationJournal.entries = [...applicationJournal.entries.slice(0, prefix), ...targetJournal.entries.slice(prefix), ...moved.map(({ entry }) => entry)];
  await writeFile(path.join(directory, "meta", "_journal.json"), `${JSON.stringify(applicationJournal, null, 2)}\n`);
  const after = await auditMigrations(applicationRoot, templateRoot);
  if (after.classification !== "application-ahead" && after.classification !== "matching") throw new Error(`Rebase left the journal ${after.classification}`);
  return { adopted, moved: moved.map(({ from, to }) => ({ from, to })) };
}
