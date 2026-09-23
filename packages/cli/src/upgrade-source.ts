import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TRESTLEJS_VERSION } from "@trestlejs/core";
import { planUpgrade } from "./upgrade.js";

export type SourceDiffClassification = "same" | "unchanged" | "modified" | "new" | "missing" | "unverified" | "unsafe";
export type SourceDiffEntry = Readonly<{ path: string; classification: SourceDiffClassification }>;
export type SourceDiffReport = Readonly<{
  sourceTemplateVersion: string | null;
  targetTemplateVersion: string;
  baselineTrusted: boolean;
  entries: readonly SourceDiffEntry[];
  summary: Readonly<Record<SourceDiffClassification, number>>;
}>;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const defaultTemplateRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "template");

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
    && baseline.templateVersion === framework?.templateVersion && baseline.files !== null && typeof baseline.files === "object";
  const summary: Record<SourceDiffClassification, number> = { same: 0, unchanged: 0, modified: 0, new: 0, missing: 0, unverified: 0, unsafe: 0 };
  const entries: SourceDiffEntry[] = [];
  for (const relative of await templateFiles(templateRoot)) {
    const sourceRelative = relative === ".gitignore" ? "_gitignore" : relative;
    const targetHash = digest(render(await readFile(path.join(templateRoot, sourceRelative), "utf8"), projectName));
    const applicationPath = path.join(root, relative);
    let currentHash: string | undefined;
    let unsafe = !(await safeApplicationPath(root, relative));
    try {
      if (!unsafe) {
        const stat = await lstat(applicationPath);
        if (!stat.isFile()) unsafe = true;
        else currentHash = digest(await readFile(applicationPath, "utf8"));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let classification: SourceDiffClassification;
    if (unsafe) classification = "unsafe";
    else if (currentHash === targetHash) classification = "same";
    else if (!baselineTrusted) classification = "unverified";
    else if (currentHash === undefined) classification = baseline!.files![relative] ? "missing" : "new";
    else classification = baseline!.files![relative] === currentHash ? "unchanged" : "modified";
    summary[classification] += 1;
    entries.push({ path: relative, classification });
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
  const conflicts = report.entries.filter(({ path: relative, classification }) => {
    if (relative === ".trestle/framework.json") return classification === "unsafe";
    const safeChange = classification === "same" || classification === "unchanged" || classification === "new";
    return !safeChange || (classification !== "same" && protectedSourcePath(relative));
  });
  if (conflicts.length) throw new Error(`Source apply requires manual review: ${conflicts.map(({ path: relative }) => relative).join(", ")}`);

  const changed: string[] = [];
  for (const entry of report.entries) {
    if (entry.path === ".trestle/framework.json") continue;
    if (entry.classification !== "unchanged" && entry.classification !== "new") continue;
    if (!(await safeApplicationPath(root, entry.path))) throw new Error(`Unsafe application path: ${entry.path}`);
    const current = await optionalText(path.join(root, entry.path));
    const baselineSource = await readFile(path.join(root, ".trestle", "template-baseline.json"), "utf8");
    const baseline = JSON.parse(baselineSource) as { files: Record<string, string> };
    if ((current === undefined && entry.classification !== "new")
      || (current !== undefined && (entry.classification !== "unchanged" || digest(current) !== baseline.files[entry.path]))) {
      throw new Error(`Application file changed during source apply: ${entry.path}`);
    }
    const sourceRelative = entry.path === ".gitignore" ? "_gitignore" : entry.path;
    const target = render(await readFile(path.join(templateRoot, sourceRelative), "utf8"), projectName);
    const destination = path.join(root, entry.path);
    await mkdir(path.dirname(destination), { recursive: true });
    if (!(await safeApplicationPath(root, entry.path))) throw new Error(`Unsafe application path: ${entry.path}`);
    await writeFile(destination, target, { encoding: "utf8", flag: entry.classification === "new" ? "wx" : "w" });
    changed.push(entry.path);
  }
  return changed;
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
