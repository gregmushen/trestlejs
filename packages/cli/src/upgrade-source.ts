import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyManifestCapabilities, parseProjectManifest, templatePathCapability, TRESTLEJS_VERSION, type OptionalTemplateCapability } from "@trestlejs/core";
import { planUpgrade } from "./upgrade.js";

export type SourceDiffClassification = "same" | "unchanged" | "modified" | "new" | "missing" | "unverified" | "unsafe"
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

function render(source: string, projectName: string): string {
  const bucketSource = `${projectName}-worker-artifacts`;
  const artifactBucket = bucketSource.length <= 63 ? bucketSource
    : `${bucketSource.slice(0, 54).replace(/-+$/u, "")}-${digest(bucketSource).slice(0, 8)}`;
  return source.replaceAll("__TRESTLE_ARTIFACT_BUCKET__", artifactBucket)
    .replaceAll("__TRESTLE_PROJECT_NAME__", projectName)
    .replaceAll("__TRESTLEJS_VERSION__", TRESTLEJS_VERSION);
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

function adjacentAlpha(from: string | null, to: string): boolean {
  const before = /^0\.1\.0-alpha\.(\d+)$/u.exec(from ?? "");
  const after = /^0\.1\.0-alpha\.(\d+)$/u.exec(to);
  return Boolean(before && after && Number(after![1]) === Number(before![1]) + 1);
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

/** Target template files for this project: optional capabilities are included only when enabled. */
async function targetTemplateFiles(templateRoot: string, enabled: ReadonlySet<OptionalTemplateCapability>): Promise<string[]> {
  return (await templateFiles(templateRoot)).filter((relative) => { const capability = templatePathCapability(relative); return !capability || enabled.has(capability); });
}

/** Rendered target content, with the project manifest reflecting enabled optional capabilities. */
async function targetContent(templateRoot: string, relative: string, projectName: string, enabled: ReadonlySet<OptionalTemplateCapability>): Promise<string> {
  const sourceRelative = relative === ".gitignore" ? "_gitignore" : relative;
  const rendered = render(await readFile(path.join(templateRoot, sourceRelative), "utf8"), projectName);
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
  let baseline: { schemaVersion?: number; templateVersion?: string; files?: Record<string, string> } | undefined;
  let framework: { templateVersion?: string } | undefined;
  try { baseline = baselineSource ? JSON.parse(baselineSource) : undefined; }
  catch { /* A corrupt baseline is never trusted. */ }
  try { framework = frameworkSource ? JSON.parse(frameworkSource) : undefined; }
  catch { /* A corrupt framework marker is never trusted. */ }
  const baselineTrusted = baseline?.schemaVersion === 1 && typeof baseline.templateVersion === "string"
    && baseline.templateVersion === framework?.templateVersion && validBaselineFiles(baseline.files);
  const summary: Record<SourceDiffClassification, number> = { same: 0, unchanged: 0, modified: 0, new: 0, missing: 0, unverified: 0, unsafe: 0, retired: 0, "retired-modified": 0, "retired-missing": 0 };
  const entries: SourceDiffEntry[] = [];
  // Optional capabilities (for example the platform admin) are part of the target only when the project enables them.
  const enabled = await enabledCapabilities(root);
  const targetFiles = await targetTemplateFiles(templateRoot, enabled);
  for (const relative of targetFiles) {
    const targetHash = digest(await targetContent(templateRoot, relative, projectName, enabled));
    const { hash: currentHash, unsafe } = await applicationHash(root, relative);
    let classification: SourceDiffClassification;
    if (unsafe) classification = "unsafe";
    else if (currentHash === targetHash) classification = "same";
    else if (!baselineTrusted) classification = "unverified";
    else if (currentHash === undefined) classification = baseline!.files![relative] ? "missing" : "new";
    else classification = baseline!.files![relative] === currentHash ? "unchanged" : "modified";
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

/** Applies only pristine files from the immediately preceding alpha. This is
 * intentionally not certification: framework metadata stays at its old source
 * version until migrations, generated tests, and provider wiring are reviewed. */
export async function applySourceUpgrade(root: string, projectName: string, templateRoot = defaultTemplateRoot): Promise<readonly string[]> {
  const report = await planSourceDiff(root, projectName, templateRoot);
  if (!report.baselineTrusted || !adjacentAlpha(report.sourceTemplateVersion, report.targetTemplateVersion)) {
    throw new Error("Source apply requires a matching baseline from the immediately preceding alpha; use upgrade diff for manual review");
  }
  const upgrade = await planUpgrade(root);
  if (upgrade.operations.find(({ id }) => id === "cli-version")?.classification !== "already-correct") {
    throw new Error("Source apply requires the target CLI version in both package.json and pnpm-lock.yaml");
  }
  const packageManifestMatches = await expectedPackageManifest(root, projectName, templateRoot);
  const conflicts = report.entries.filter(({ path: relative, classification }) => {
    if (relative === ".trestle/framework.json") return classification === "unsafe";
    if (relative === "package.json" && packageManifestMatches) return false;
    const safeChange = classification === "same" || classification === "unchanged" || classification === "new" || classification === "retired-missing";
    return !safeChange || (classification !== "same" && protectedSourcePath(relative));
  });
  if (conflicts.length) throw new Error(`Source apply requires manual review: ${conflicts.map(({ path: relative }) => relative).join(", ")}`);

  const enabled = await enabledCapabilities(root);
  const changed: string[] = [];
  for (const entry of report.entries) {
    if (entry.path === ".trestle/framework.json") continue;
    if (entry.path === "package.json" && packageManifestMatches) continue;
    if (entry.classification !== "unchanged" && entry.classification !== "new") continue;
    if (!(await safeApplicationPath(root, entry.path))) throw new Error(`Unsafe application path: ${entry.path}`);
    const current = await optionalText(path.join(root, entry.path));
    const baselineSource = await readFile(path.join(root, ".trestle", "template-baseline.json"), "utf8");
    const baseline = JSON.parse(baselineSource) as { files: Record<string, string> };
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
  return changed;
}

async function assertSourceReadyToFinalize(root: string, projectName: string, templateRoot: string): Promise<void> {
  const report = await planSourceDiff(root, projectName, templateRoot);
  if (!report.baselineTrusted || !adjacentAlpha(report.sourceTemplateVersion, report.targetTemplateVersion)) {
    throw new Error("Source finalization requires a matching baseline from the immediately preceding alpha");
  }
  const upgrade = await planUpgrade(root);
  if (upgrade.operations.find(({ id }) => id === "cli-version")?.classification !== "already-correct") {
    throw new Error("Source finalization requires the target CLI version in package.json and pnpm-lock.yaml");
  }
  const packageManifestMatches = await expectedPackageManifest(root, projectName, templateRoot);
  const conflicts = report.entries.filter(({ path: relative, classification }) => {
    if (relative === ".trestle/framework.json") return classification !== "unchanged" && classification !== "same";
    if (relative === "package.json") return !packageManifestMatches;
    return classification !== "same" && classification !== "retired-missing";
  });
  if (conflicts.length) throw new Error(`Source finalization requires target parity and review of retired files: ${conflicts.map(({ path: relative }) => relative).join(", ")}`);
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
    } else if (current !== target) throw new Error(`Application file changed during source finalization: ${relative}`);
    files[relative] = digest(current);
  }
  await assertSourceReadyToFinalize(root, projectName, templateRoot);
  await writeFile(path.join(root, ".trestle", "template-baseline.json"), `${JSON.stringify({ schemaVersion: 1, templateVersion: TRESTLEJS_VERSION, files }, null, 2)}\n`, "utf8");
  await writeFile(markerPath, updatedMarker, "utf8");
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
