import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyManifestCapabilities, parseProjectManifest, templatePathCapability, TRESTLEJS_VERSION, type OptionalTemplateCapability } from "./core.js";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

import { planUpgrade } from "./upgrade.js";
import { auditMigrations } from "./upgrade-migrations.js";

const execFileAsync = promisify(execFile);

/** Migration SQL, journal, and snapshots are reconciled by `upgrade migrations --rebase`, not by text merges. */
const migrationFile = (relative: string) => /^packages\/db\/migrations\/(?:[^/]+\.sql|meta\/(?:_journal|\d{4,}_snapshot)\.json)$/u.test(relative);
const conflictMarker = /^(?:<{7}|>{7}) /mu;

async function migrationChainConsistent(root: string, templateRoot: string): Promise<boolean> {
  const audit = await auditMigrations(root, templateRoot).catch(() => undefined);
  return audit?.classification === "matching" || audit?.classification === "application-ahead";
}

/**
 * The previous release's template, needed to three-way merge files both the
 * application and the framework changed. Fetched with `npm pack`; set
 * TRESTLE_UPGRADE_SOURCE_TEMPLATE to a template directory to work offline.
 */
export async function sourceTemplateRoot(version: string): Promise<string | undefined> {
  const override = process.env.TRESTLE_UPGRADE_SOURCE_TEMPLATE;
  if (override) return existsSync(override) ? override : undefined;
  const directory = await mkdtemp(path.join(os.tmpdir(), "trestle-source-template-"));
  try {
    await execFileAsync("npm", ["pack", `trestlejs@${version}`, "--pack-destination", directory, "--silent"], { timeout: 120_000 });
    const tarball = (await readdir(directory)).find((name) => name.endsWith(".tgz"));
    if (!tarball) return undefined;
    await execFileAsync("tar", ["-xzf", path.join(directory, tarball), "-C", directory]);
    const root = path.join(directory, "package", "dist", "template");
    return existsSync(root) ? root : undefined;
  } catch {
    return undefined;
  }
}

/** `inserted` is `base` with lines only added before and after it; returns those lines. */
function insertionAround(inserted: readonly string[], base: readonly string[]): { before: string[]; after: string[] } | undefined {
  for (let start = 0; start + base.length <= inserted.length; start += 1) {
    if (base.every((line, index) => inserted[start + index] === line)) return { before: inserted.slice(0, start), after: inserted.slice(start + base.length) };
  }
  return undefined;
}

/** `changed` is `base` with one run of characters inserted; returns where and what. */
function lineInsertion(changed: string, base: string): { at: number; text: string } | undefined {
  if (changed.length <= base.length) return undefined;
  let prefix = 0;
  while (prefix < base.length && changed[prefix] === base[prefix]) prefix += 1;
  const text = changed.slice(prefix, prefix + changed.length - base.length);
  return changed.slice(prefix + text.length) === base.slice(prefix) ? { at: prefix, text } : undefined;
}

/** Both sides inserted into the same single line, e.g. an entry added to a list literal. */
function mergeLine(application: string, base: string, target: string): string | undefined {
  const ours = lineInsertion(application, base);
  const theirs = lineInsertion(target, base);
  if (!ours || !theirs) return undefined;
  const [first, second] = ours.at <= theirs.at ? [ours, theirs] : [theirs, ours];
  return `${base.slice(0, first.at)}${first.text}${base.slice(first.at, second.at)}${second.text}${base.slice(second.at)}`;
}

/**
 * One base line that both sides extended in place, where either side may also
 * have inserted whole lines around it (a generated route declaration above the
 * route list it joins).
 */
function singleLineMerge(application: readonly string[], base: readonly string[], target: readonly string[]): string[] | undefined {
  if (base.length !== 1) return undefined;
  for (const [ours, theirs, oursFirst] of [[application, target, true], [target, application, false]] as const) {
    if (theirs.length !== 1) continue;
    for (let index = 0; index < ours.length; index += 1) {
      const merged = oursFirst ? mergeLine(ours[index]!, base[0]!, theirs[0]!) : mergeLine(theirs[0]!, base[0]!, ours[index]!);
      if (merged !== undefined) return [...ours.slice(0, index), merged, ...ours.slice(index + 1)];
    }
  }
  return undefined;
}

/**
 * Settles the conflicts git reports only because edits touch: one side only
 * inserted lines around unchanged base text (generators prepend imports and
 * append registrations), or both sides inserted at the same place (framework
 * text first, then the application's). Anything else keeps its markers.
 */
export function settleAdjacentConflicts(merged: string): { text: string; conflicts: boolean } {
  const lines = merged.split("\n");
  const output: string[] = [];
  let conflicts = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]!.startsWith("<<<<<<< ")) { output.push(lines[index]!); continue; }
    const block = { application: [] as string[], base: [] as string[], target: [] as string[] };
    let section: keyof typeof block = "application";
    const raw = [lines[index]!];
    for (index += 1; index < lines.length && !lines[index]!.startsWith(">>>>>>> "); index += 1) {
      raw.push(lines[index]!);
      if (lines[index]!.startsWith("||||||| ")) section = "base";
      else if (lines[index] === "=======") section = "target";
      else block[section].push(lines[index]!);
    }
    raw.push(lines[index] ?? "");
    const application = insertionAround(block.application, block.base);
    const target = insertionAround(block.target, block.base);
    const containsTarget = block.target.length > 0 ? insertionAround(block.application, block.target) : undefined;
    if (block.base.length === 0) output.push(...block.target, ...block.application);
    // The application already has the framework's version, plus its own inserted lines.
    else if (containsTarget) output.push(...block.application);
    else if (application) output.push(...application.before, ...block.target, ...application.after);
    else if (target) output.push(...target.before, ...block.application, ...target.after);
    else if (singleLineMerge(block.application, block.base, block.target)) output.push(...singleLineMerge(block.application, block.base, block.target)!);
    else { output.push(...raw); conflicts = true; }
  }
  return { text: output.join("\n"), conflicts };
}

/** git merge-file: the application's version, the previous template, and the new template. */
async function mergeThreeWay(application: string, previous: string, target: string): Promise<{ text: string; conflicts: boolean } | undefined> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trestle-merge-"));
  try {
    const files = ["application", "previous", "target"].map((name) => path.join(directory, name));
    await writeFile(files[0]!, application, "utf8");
    await writeFile(files[1]!, previous, "utf8");
    await writeFile(files[2]!, target, "utf8");
    try {
      const { stdout } = await execFileAsync("git", ["merge-file", "-p", "--diff3", "-L", "application", "-L", "previous template", "-L", "new template", ...files], { maxBuffer: 16 * 1024 * 1024 });
      return { text: stdout, conflicts: false };
    } catch (error) {
      const failure = error as { code?: number | string; stdout?: string };
      if (typeof failure.code === "number" && failure.code > 0 && typeof failure.stdout === "string") return settleAdjacentConflicts(failure.stdout);
      return undefined;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** kept: the application changed a file the target did not change, so the application's version stays. */
export type SourceDiffClassification = "same" | "unchanged" | "kept" | "modified" | "new" | "missing" | "unverified" | "unsafe"
  | "retired" | "retired-modified" | "retired-missing";
export type SourceDiffEntry = Readonly<{ path: string; classification: SourceDiffClassification }>;
export type SourceDiffReport = Readonly<{
  sourceTemplateVersion: string | null;
  targetTemplateVersion: string;
  baselineTrusted: boolean;
  entries: readonly SourceDiffEntry[];
  summary: Readonly<Record<SourceDiffClassification, number>>;
}>;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundledTemplateRoot = path.join(moduleDirectory, "template");
const defaultTemplateRoot = existsSync(bundledTemplateRoot) ? bundledTemplateRoot : path.join(moduleDirectory, "..", "..", "create", "template");

function render(source: string, projectName: string, version = TRESTLEJS_VERSION): string {
  const bucketSource = `${projectName}-worker-artifacts`;
  const artifactBucket = bucketSource.length <= 63 ? bucketSource
    : `${bucketSource.slice(0, 54).replace(/-+$/u, "")}-${digest(bucketSource).slice(0, 8)}`;
  return source.replaceAll("__TRESTLE_ARTIFACT_BUCKET__", artifactBucket)
    .replaceAll("__TRESTLE_PROJECT_NAME__", projectName)
    .replaceAll("__TRESTLEJS_VERSION__", version);
}

async function templateFiles(directory: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = entry.name === "_gitignore" ? ".gitignore" : entry.name;
    const next = path.posix.join(relative, name);
    if (entry.isDirectory()) files.push(...await templateFiles(path.join(directory, entry.name), next));
    else if (entry.isFile()) files.push(next);
    else throw new Error(`Unsupported target template entry: ${next}`);
  }
  return files.sort();
}

async function optionalText(target: string): Promise<string | undefined> {
  try { return await readFile(target, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function safeApplicationPath(root: string, relative: string): Promise<boolean> {
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) return false;
      if (current !== path.join(root, relative) && !stat.isDirectory()) return false;
      if (current === path.join(root, relative) && !stat.isFile()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }
  return true;
}

function validBaselineFiles(files: unknown): files is Record<string, string> {
  if (files === null || typeof files !== "object" || Array.isArray(files)) return false;
  const entries = Object.entries(files);
  if (entries.length > 10_000) return false;
  return entries.every(([relative, hash]) => relative.length > 0 && !relative.includes("\\")
    && !relative.includes(":") && !path.win32.isAbsolute(relative)
    && relative.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    && path.posix.normalize(relative) === relative && /^[a-f0-9]{64}$/u.test(hash));
}

async function applicationHash(root: string, relative: string): Promise<{ hash?: string; unsafe: boolean }> {
  if (!(await safeApplicationPath(root, relative))) return { unsafe: true };
  try {
    const applicationPath = path.join(root, relative);
    const stat = await lstat(applicationPath);
    return stat.isFile() ? { hash: digest(await readFile(applicationPath, "utf8")), unsafe: false } : { unsafe: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { unsafe: false };
    throw error;
  }
}

function protectedSourcePath(relative: string): boolean {
  return relative === ".trestle/framework.json" || relative === ".trestle/project.yaml"
    || relative === ".trestle/recovery.json" || relative.startsWith(".github/workflows/")
    || relative.startsWith("config/") || relative.startsWith("packages/db/migrations/")
    || relative.endsWith("/wrangler.jsonc") || relative === "wrangler.jsonc";
}

function adjacentRelease(from: string | null, to: string): boolean {
  if (from === "0.1.0-alpha.135" && to === "0.1.0-beta.1") return true;
  // beta.2 was tagged but failed before npm publication. beta.1 is the
  // previous installable release for beta.3 projects.
  if (from === "0.1.0-beta.1" && to === "0.1.0-beta.3") return true;
  const beforeBeta = /^0\.1\.0-beta\.(\d+)$/u.exec(from ?? "");
  const afterBeta = /^0\.1\.0-beta\.(\d+)$/u.exec(to);
  if (beforeBeta && afterBeta) return Number(afterBeta[1]) === Number(beforeBeta[1]) + 1;
  const before = /^0\.1\.0-alpha\.(\d+)$/u.exec(from ?? "");
  const after = /^0\.1\.0-alpha\.(\d+)$/u.exec(to);
  return Boolean(before && after && Number(after![1]) === Number(before![1]) + 1);
}

/** package.json is compared as JSON: pnpm and editors reformat it without changing it. */
async function samePackageManifest(root: string, templateRoot: string, projectName: string, enabled: ReadonlySet<OptionalTemplateCapability>): Promise<boolean> {
  try {
    return canonicalJson(JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))) === canonicalJson(JSON.parse(await targetContent(templateRoot, "package.json", projectName, enabled)));
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function expectedPackageManifest(root: string, projectName: string, templateRoot: string): Promise<boolean> {
  if (!(await safeApplicationPath(root, "package.json"))) return false;
  try {
    const current = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const target = JSON.parse(render(await readFile(path.join(templateRoot, "package.json"), "utf8"), projectName));
    return canonicalJson(current) === canonicalJson(target);
  } catch { return false; }
}

/** pnpm must update the CLI dependency before source apply. Accept that one
 * edit only against hash-verified generated source (or exact legacy bytes);
 * other application manifest changes still need review. */
async function pristinePackageVersionBump(root: string, previousVersion: string, baselineHash: string | undefined, baselineSource?: string): Promise<boolean> {
  if (!baselineHash || !(await safeApplicationPath(root, "package.json"))) return false;
  try {
    const source = await readFile(path.join(root, "package.json"), "utf8");
    const manifest = JSON.parse(source) as { devDependencies?: { trestlejs?: string } };
    if (manifest.devDependencies?.trestlejs !== TRESTLEJS_VERSION) return false;
    if (baselineSource !== undefined) {
      if (digest(baselineSource) !== baselineHash) return false;
      const previous = JSON.parse(baselineSource) as { devDependencies?: { trestlejs?: string } };
      if (previous.devDependencies?.trestlejs !== previousVersion) return false;
      previous.devDependencies.trestlejs = TRESTLEJS_VERSION;
      return canonicalJson(manifest) === canonicalJson(previous);
    }
    let replacements = 0;
    const restored = source.replace(/("trestlejs"\s*:\s*")([^"]+)(")/gu, (match, before: string, version: string, after: string) => {
      if (version !== TRESTLEJS_VERSION) return match;
      replacements += 1;
      return `${before}${previousVersion}${after}`;
    });
    return replacements === 1 && digest(restored) === baselineHash;
  } catch { return false; }
}

/** Target template files for this project: optional capabilities are included only when enabled. */
async function targetTemplateFiles(templateRoot: string, enabled: ReadonlySet<OptionalTemplateCapability>): Promise<string[]> {
  return (await templateFiles(templateRoot)).filter((relative) => { const capability = templatePathCapability(relative); return !capability || enabled.has(capability); });
}

/** Rendered target content, with the project manifest reflecting enabled optional capabilities. */
async function targetContent(templateRoot: string, relative: string, projectName: string, enabled: ReadonlySet<OptionalTemplateCapability>, version = TRESTLEJS_VERSION): Promise<string> {
  const sourceRelative = relative === ".gitignore" ? "_gitignore" : relative;
  const rendered = render(await readFile(path.join(templateRoot, sourceRelative), "utf8"), projectName, version);
  return relative === ".trestle/project.yaml" ? applyManifestCapabilities(rendered, enabled) : rendered;
}

async function enabledCapabilities(root: string): Promise<ReadonlySet<OptionalTemplateCapability>> {
  const source = await safeApplicationPath(root, ".trestle/project.yaml") ? await optionalText(path.join(root, ".trestle", "project.yaml")) : undefined;
  try { return new Set<OptionalTemplateCapability>(source && parseProjectManifest(source).capabilities.admin ? ["admin"] : []); }
  catch { return new Set(); }
}

/** Read-only inventory of paths owned by the target template. It never reads
 * through an application symlink and never assumes a missing baseline means
 * that application source is safe to replace. */
export async function planSourceDiff(root: string, projectName: string, templateRoot = defaultTemplateRoot): Promise<SourceDiffReport> {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(projectName)) throw new Error("Invalid project name for source inventory");
  const baselineSource = await safeApplicationPath(root, ".trestle/template-baseline.json")
    ? await optionalText(path.join(root, ".trestle", "template-baseline.json")) : undefined;
  const frameworkSource = await safeApplicationPath(root, ".trestle/framework.json")
    ? await optionalText(path.join(root, ".trestle", "framework.json")) : undefined;
  let baseline: { schemaVersion?: number; templateVersion?: string; files?: Record<string, string>; packageSource?: unknown } | undefined;
  let framework: { templateVersion?: string } | undefined;
  try { baseline = baselineSource ? JSON.parse(baselineSource) : undefined; }
  catch { /* A corrupt baseline is never trusted. */ }
  try { framework = frameworkSource ? JSON.parse(frameworkSource) : undefined; }
  catch { /* A corrupt framework marker is never trusted. */ }
  const baselineTrusted = baseline?.schemaVersion === 1 && typeof baseline.templateVersion === "string"
    && baseline.templateVersion === framework?.templateVersion && validBaselineFiles(baseline.files)
    && (baseline.packageSource === undefined || typeof baseline.packageSource === "string"
      && baseline.packageSource.length <= 100_000 && digest(baseline.packageSource) === baseline.files["package.json"]);
  const summary: Record<SourceDiffClassification, number> = { same: 0, unchanged: 0, kept: 0, modified: 0, new: 0, missing: 0, unverified: 0, unsafe: 0, retired: 0, "retired-modified": 0, "retired-missing": 0 };
  const entries: SourceDiffEntry[] = [];
  // Optional capabilities (for example the platform admin) are part of the target only when the project enables them.
  const enabled = await enabledCapabilities(root);
  const targetFiles = await targetTemplateFiles(templateRoot, enabled);
  for (const relative of targetFiles) {
    const targetHash = digest(await targetContent(templateRoot, relative, projectName, enabled));
    const { hash: currentHash, unsafe } = await applicationHash(root, relative);
    let classification: SourceDiffClassification;
    if (unsafe) classification = "unsafe";
    else if (currentHash === targetHash || (relative === "package.json" && currentHash !== undefined && await samePackageManifest(root, templateRoot, projectName, enabled))) classification = "same";
    else if (!baselineTrusted) classification = "unverified";
    else if (currentHash === undefined) classification = baseline!.files![relative] ? "missing" : "new";
    else classification = baseline!.files![relative] === currentHash ? "unchanged" : baseline!.files![relative] === targetHash ? "kept" : "modified";
    summary[classification] += 1;
    entries.push({ path: relative, classification });
  }
  if (baselineTrusted) {
    const targetSet = new Set(targetFiles);
    for (const relative of Object.keys(baseline!.files!).sort()) {
      if (targetSet.has(relative)) continue;
      const { hash: currentHash, unsafe } = await applicationHash(root, relative);
      const classification: SourceDiffClassification = unsafe ? "unsafe" : currentHash === undefined ? "retired-missing"
        : currentHash === baseline!.files![relative] ? "retired" : "retired-modified";
      summary[classification] += 1;
      entries.push({ path: relative, classification });
    }
  }
  return { sourceTemplateVersion: framework?.templateVersion ?? null, targetTemplateVersion: TRESTLEJS_VERSION, baselineTrusted, entries, summary };
}

/** Applies only pristine files from the immediately preceding release. This is
 * intentionally not certification: framework metadata stays at its old source
 * version until migrations, generated tests, and provider wiring are reviewed. */
export async function applySourceUpgrade(root: string, projectName: string, templateRoot = defaultTemplateRoot, options: Readonly<{ accept?: readonly string[] }> = {}): Promise<readonly string[]> {
  const accepted = new Set(options.accept ?? []);
  const report = await planSourceDiff(root, projectName, templateRoot);
  if (!report.baselineTrusted || !adjacentRelease(report.sourceTemplateVersion, report.targetTemplateVersion)) {
    throw new Error("Source apply requires a matching baseline from the immediately preceding release; use upgrade diff for manual review");
  }
  const upgrade = await planUpgrade(root);
  if (upgrade.operations.find(({ id }) => id === "cli-version")?.classification !== "already-correct") {
    throw new Error("Source apply requires the target CLI version in both package.json and pnpm-lock.yaml");
  }
  const packageManifestMatches = await expectedPackageManifest(root, projectName, templateRoot);
  const baseline = JSON.parse(await readFile(path.join(root, ".trestle", "template-baseline.json"), "utf8")) as { files: Record<string, string>; packageSource?: string };
  const packageVersionOnly = await pristinePackageVersionBump(root, report.sourceTemplateVersion!, baseline.files["package.json"], baseline.packageSource);
  const migrationsConsistent = await migrationChainConsistent(root, templateRoot);
  const conflicts = report.entries.filter(({ path: relative, classification }) => {
    if (relative === ".trestle/framework.json") return classification === "unsafe";
    if (relative === "package.json" && (packageManifestMatches || packageVersionOnly)) return false;
    if (migrationFile(relative) && migrationsConsistent) return false;
    // Dependency and script edits in package.json are reviewed, never merged.
    if (relative === "package.json") return classification !== "same" && classification !== "unchanged" && classification !== "kept";
    // Deployment and configuration files change only when explicitly accepted after review.
    const reviewed = protectedSourcePath(relative) && !migrationFile(relative) && accepted.has(relative);
    if (classification === "modified") return migrationFile(relative) || (protectedSourcePath(relative) && !reviewed);
    const safeChange = classification === "same" || classification === "unchanged" || classification === "kept" || classification === "new" || classification === "retired-missing";
    return !safeChange || (classification !== "same" && classification !== "kept" && protectedSourcePath(relative) && !reviewed);
  });
  const unknown = [...accepted].filter((relative) => !report.entries.some((entry) => entry.path === relative && protectedSourcePath(relative)));
  if (unknown.length) throw new Error(`--accept names paths that are not protected template files: ${unknown.join(", ")}`);
  if (conflicts.length) {
    const migrations = conflicts.filter(({ path: relative }) => migrationFile(relative));
    const protectedFiles = conflicts.filter(({ path: relative, classification }) => protectedSourcePath(relative) && !migrationFile(relative) && (classification === "unchanged" || classification === "modified" || classification === "new"));
    const other = conflicts.filter((entry) => !migrations.includes(entry) && !protectedFiles.includes(entry));
    throw new Error([
      "Source apply requires review:",
      ...(migrations.length ? [`- migrations (${migrations.length} files): reconcile the journal first with trestle upgrade migrations --rebase --yes`] : []),
      ...(protectedFiles.length ? [`- deployment and configuration files: review each with trestle upgrade diff --path <file>, then rerun with --accept ${protectedFiles.map(({ path: relative }) => relative).join(" ")}`] : []),
      ...other.map(({ path: relative, classification }) => `- ${relative} (${classification}): resolve by hand`),
    ].join("\n"));
  }

  const enabled = await enabledCapabilities(root);
  const merges = report.entries.filter(({ path: relative, classification }) => classification === "modified" && !migrationFile(relative) && relative !== "package.json" && relative !== ".trestle/framework.json");
  const previousTemplate = merges.length ? await sourceTemplateRoot(report.sourceTemplateVersion!) : undefined;
  if (merges.length && !previousTemplate) {
    throw new Error(`Merging ${merges.map(({ path: relative }) => relative).join(", ")} needs the ${report.sourceTemplateVersion} template; check network access to npm or set TRESTLE_UPGRADE_SOURCE_TEMPLATE`);
  }
  const changed: string[] = [];
  const conflicted: string[] = [];
  for (const entry of report.entries) {
    if (entry.path === ".trestle/framework.json") continue;
    if (migrationFile(entry.path) && migrationsConsistent && entry.classification !== "new" && entry.classification !== "unchanged") continue;
    if (entry.path === "package.json" && packageManifestMatches) continue;
    if (entry.path === "package.json" && packageVersionOnly) {
      if (!(await pristinePackageVersionBump(root, report.sourceTemplateVersion!, baseline.files["package.json"], baseline.packageSource))) {
        throw new Error("Application package.json changed during source apply");
      }
      await writeFile(path.join(root, "package.json"), await targetContent(templateRoot, "package.json", projectName, enabled), "utf8");
      changed.push(entry.path);
      continue;
    }
    if (entry.classification === "modified") {
      const current = await readFile(path.join(root, entry.path), "utf8");
      const previous = await targetContent(previousTemplate!, entry.path, projectName, enabled, report.sourceTemplateVersion!);
      if (digest(previous) !== baseline.files[entry.path]) throw new Error(`The fetched ${report.sourceTemplateVersion} template does not match the recorded baseline for ${entry.path}`);
      const merged = await mergeThreeWay(current, previous, await targetContent(templateRoot, entry.path, projectName, enabled));
      if (!merged) throw new Error(`Could not merge ${entry.path}: git merge-file is unavailable`);
      if (digest(await readFile(path.join(root, entry.path), "utf8")) !== digest(current)) throw new Error(`Application file changed during source apply: ${entry.path}`);
      await writeFile(path.join(root, entry.path), merged.text, "utf8");
      changed.push(entry.path);
      if (merged.conflicts) conflicted.push(entry.path);
      continue;
    }
    if (entry.classification !== "unchanged" && entry.classification !== "new") continue;
    if (!(await safeApplicationPath(root, entry.path))) throw new Error(`Unsafe application path: ${entry.path}`);
    const current = await optionalText(path.join(root, entry.path));
    if ((current === undefined && entry.classification !== "new")
      || (current !== undefined && (entry.classification !== "unchanged" || digest(current) !== baseline.files[entry.path]))) {
      throw new Error(`Application file changed during source apply: ${entry.path}`);
    }
    const target = await targetContent(templateRoot, entry.path, projectName, enabled);
    const destination = path.join(root, entry.path);
    await mkdir(path.dirname(destination), { recursive: true });
    if (!(await safeApplicationPath(root, entry.path))) throw new Error(`Unsafe application path: ${entry.path}`);
    await writeFile(destination, target, { encoding: "utf8", flag: entry.classification === "new" ? "wx" : "w" });
    changed.push(entry.path);
  }
  // Finalization accepts exactly these files once they carry no conflict markers.
  const statePath = path.join(root, ".trestle", "upgrade-state.json");
  const merged = report.entries.filter(({ path: relative, classification }) => classification === "modified" && !migrationFile(relative) && relative !== "package.json" && relative !== ".trestle/framework.json").map(({ path: relative }) => relative);
  const previousState = JSON.parse(await optionalText(statePath) ?? "{}") as { targetTemplateVersion?: string; merged?: string[] };
  const recorded = previousState.targetTemplateVersion === report.targetTemplateVersion ? previousState.merged ?? [] : [];
  await writeFile(statePath, `${JSON.stringify({ schemaVersion: 1, sourceTemplateVersion: report.sourceTemplateVersion, targetTemplateVersion: report.targetTemplateVersion, merged: [...new Set([...recorded, ...merged])].sort() }, null, 2)}\n`, "utf8");
  if (conflicted.length) {
    throw new Error(`Merged framework changes, but these files have conflicts marked with <<<<<<< and >>>>>>>: ${conflicted.join(", ")}. Resolve them, then run trestle upgrade source-finalize --yes`);
  }
  return changed;
}

async function assertSourceReadyToFinalize(root: string, projectName: string, templateRoot: string): Promise<void> {
  const report = await planSourceDiff(root, projectName, templateRoot);
  if (!report.baselineTrusted || !adjacentRelease(report.sourceTemplateVersion, report.targetTemplateVersion)) {
    throw new Error("Source finalization requires a matching baseline from the immediately preceding release");
  }
  const upgrade = await planUpgrade(root);
  if (upgrade.operations.find(({ id }) => id === "cli-version")?.classification !== "already-correct") {
    throw new Error("Source finalization requires the target CLI version in package.json and pnpm-lock.yaml");
  }
  const packageManifestMatches = await expectedPackageManifest(root, projectName, templateRoot);
  const migrationsConsistent = await migrationChainConsistent(root, templateRoot);
  const state = JSON.parse(await optionalText(path.join(root, ".trestle", "upgrade-state.json")) ?? "{}") as { targetTemplateVersion?: string; merged?: string[] };
  const mergedThisUpgrade = new Set(state.targetTemplateVersion === report.targetTemplateVersion ? state.merged ?? [] : []);
  const unmerged: string[] = [];
  for (const entry of report.entries.filter(({ path: relative, classification }) => classification === "modified" && !migrationFile(relative) && relative !== "package.json" && relative !== ".trestle/framework.json")) {
    // A file both sides changed is final only if source-apply merged it and no conflict markers remain.
    if (!mergedThisUpgrade.has(entry.path) || conflictMarker.test(await readFile(path.join(root, entry.path), "utf8"))) unmerged.push(entry.path);
  }
  const conflicts = report.entries.filter(({ path: relative, classification }) => {
    if (relative === ".trestle/framework.json") return classification !== "unchanged" && classification !== "same";
    if (relative === "package.json") return !packageManifestMatches;
    if (migrationFile(relative) && migrationsConsistent) return false;
    if (classification === "modified") return unmerged.includes(relative);
    return classification !== "same" && classification !== "kept" && classification !== "retired-missing";
  });
  if (conflicts.length) throw new Error(`Source finalization requires target parity, merged application changes without conflict markers, and review of retired files: ${conflicts.map(({ path: relative }) => relative).join(", ")}`);
}

/** Certifies only local source parity, after the caller runs the project's
 * full check command. It does not claim deployed/provider readiness. */
export async function finalizeSourceUpgrade(
  root: string,
  projectName: string,
  verify: () => Promise<void>,
  templateRoot = defaultTemplateRoot,
): Promise<void> {
  await assertSourceReadyToFinalize(root, projectName, templateRoot);
  await verify();
  await assertSourceReadyToFinalize(root, projectName, templateRoot);

  const markerPath = path.join(root, ".trestle", "framework.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
  const updatedMarker = `${JSON.stringify({ ...marker, schemaVersion: 1, templateVersion: TRESTLEJS_VERSION }, null, 2)}\n`;
  const files: Record<string, string> = {};
  const enabled = await enabledCapabilities(root);
  for (const relative of await targetTemplateFiles(templateRoot, enabled)) {
    if (!(await safeApplicationPath(root, relative))) throw new Error(`Unsafe application path: ${relative}`);
    if (relative === ".trestle/framework.json") { files[relative] = digest(updatedMarker); continue; }
    const current = await readFile(path.join(root, relative), "utf8");
    const target = await targetContent(templateRoot, relative, projectName, enabled);
    if (relative === "package.json") {
      if (canonicalJson(JSON.parse(current)) !== canonicalJson(JSON.parse(target))) throw new Error("package.json changed during source finalization");
      files[relative] = digest(current);
      continue;
    }
    // The baseline records the template as released, so application changes stay visible to the next upgrade.
    files[relative] = digest(target);
  }
  await assertSourceReadyToFinalize(root, projectName, templateRoot);
  await writeFile(path.join(root, ".trestle", "template-baseline.json"), `${JSON.stringify({ schemaVersion: 1, templateVersion: TRESTLEJS_VERSION, files, packageSource: await readFile(path.join(root, "package.json"), "utf8") }, null, 2)}\n`, "utf8");
  await writeFile(markerPath, updatedMarker, "utf8");
  await rm(path.join(root, ".trestle", "upgrade-state.json"), { force: true });
}

/** A unified diff from the application's file to the target template's, for reviewing one path before accepting it. */
export async function sourceFileDiff(root: string, projectName: string, relative: string, templateRoot = defaultTemplateRoot): Promise<string> {
  const enabled = await enabledCapabilities(root);
  const target = await targetContent(templateRoot, relative, projectName, enabled).catch(() => undefined);
  if (target === undefined) throw new Error(`${relative} is not a target template file`);
  if (!(await safeApplicationPath(root, relative))) throw new Error(`Unsafe application path: ${relative}`);
  const directory = await mkdtemp(path.join(os.tmpdir(), "trestle-diff-"));
  try {
    const targetFile = path.join(directory, "target");
    await writeFile(targetFile, target, "utf8");
    const applicationFile = path.join(root, relative);
    const current = existsSync(applicationFile) ? applicationFile : path.join(directory, "missing");
    if (!existsSync(applicationFile)) await writeFile(current, "", "utf8");
    try {
      await execFileAsync("git", ["diff", "--no-index", "--no-color", `--src-prefix=application/`, `--dst-prefix=target/`, current, targetFile], { maxBuffer: 16 * 1024 * 1024 });
      return "";
    } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      if (failure.code === 1 && typeof failure.stdout === "string") return failure.stdout;
      throw error;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function formatSourceDiff(report: SourceDiffReport): string {
  const changed = report.entries.filter((entry) => entry.classification !== "same");
  return [
    `Template source ${report.sourceTemplateVersion ?? "unknown"} → ${report.targetTemplateVersion}`,
    report.baselineTrusted ? "Generation baseline matches the recorded source version." : "No matching generation baseline; changed paths require manual review.",
    ...changed.map((entry) => `${entry.classification.padEnd(10)} ${entry.path}`),
    `${report.summary.same} same, ${changed.length} changed; this command does not edit files.`,
    "",
  ].join("\n");
}

/**
 * Adds the optional platform admin to an existing project: renders apps/admin
 * from this CLI's template, enables it in the project manifest, and records
 * the new files in the generation baseline so later upgrades treat them as
 * template-owned. The project must already be on this CLI's template version
 * so the admin sources match its packages. Disabling is never automatic.
 */
export async function enableAdminCapability(root: string, projectName: string, templateRoot = defaultTemplateRoot): Promise<readonly string[]> {
  const manifestPath = path.join(root, ".trestle", "project.yaml");
  if (!(await safeApplicationPath(root, ".trestle/project.yaml"))) throw new Error("Unsafe application path: .trestle/project.yaml");
  const manifestSource = await readFile(manifestPath, "utf8");
  const manifest = parseProjectManifest(manifestSource);
  if (manifest.capabilities.admin) return [];
  const framework = JSON.parse(await readFile(path.join(root, ".trestle", "framework.json"), "utf8")) as { templateVersion?: string };
  if (framework.templateVersion !== TRESTLEJS_VERSION) {
    throw new Error(`Enabling the platform admin requires template ${TRESTLEJS_VERSION}; this project is on ${framework.templateVersion ?? "an unknown version"}. Run trestle upgrade first.`);
  }
  if (!manifest.secrets?.DATABASE_ADMIN_URL || manifest.secrets.DATABASE_ADMIN_URL.target !== "admin") {
    throw new Error("Declare DATABASE_ADMIN_URL with target: admin in .trestle/project.yaml before enabling the platform admin");
  }
  const enabled = new Set<OptionalTemplateCapability>(["admin"]);
  const files = (await targetTemplateFiles(templateRoot, enabled)).filter((relative) => templatePathCapability(relative) === "admin");
  for (const relative of files) {
    if (!(await safeApplicationPath(root, relative))) throw new Error(`Unsafe application path: ${relative}`);
    if (await optionalText(path.join(root, relative)) !== undefined) throw new Error(`${relative} already exists; move it aside before enabling the platform admin`);
  }
  const updatedManifest = applyManifestCapabilities(manifestSource, enabled);
  parseProjectManifest(updatedManifest);

  const written: string[] = [];
  for (const relative of files) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    if (!(await safeApplicationPath(root, relative))) throw new Error(`Unsafe application path: ${relative}`);
    await writeFile(destination, await targetContent(templateRoot, relative, projectName, enabled), { encoding: "utf8", flag: "wx" });
    written.push(relative);
  }
  await writeFile(manifestPath, updatedManifest, "utf8");

  const baselinePath = path.join(root, ".trestle", "template-baseline.json");
  const baselineSource = await safeApplicationPath(root, ".trestle/template-baseline.json") ? await optionalText(baselinePath) : undefined;
  if (baselineSource) {
    const baseline = JSON.parse(baselineSource) as { schemaVersion?: number; templateVersion?: string; files?: Record<string, string> };
    if (baseline.schemaVersion === 1 && baseline.templateVersion === TRESTLEJS_VERSION && validBaselineFiles(baseline.files)) {
      const baselineFiles: Record<string, string> = { ...baseline.files };
      for (const relative of written) baselineFiles[relative] = digest(await readFile(path.join(root, relative), "utf8"));
      // An unedited manifest stays template-owned; an edited one keeps its recorded hash and remains application-owned.
      if (baselineFiles[".trestle/project.yaml"] === digest(manifestSource)) baselineFiles[".trestle/project.yaml"] = digest(updatedManifest);
      const sorted = Object.fromEntries(Object.entries(baselineFiles).sort(([left], [right]) => left.localeCompare(right)));
      await writeFile(baselinePath, `${JSON.stringify({ ...baseline, files: sorted }, null, 2)}\n`, "utf8");
    }
  }
  return [...written, ".trestle/project.yaml"];
}
