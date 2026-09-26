import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyManifestCapabilities, loadProjectManifest, templatePathCapability, TRESTLEJS_VERSION, type OptionalTemplateCapability } from "trestlejs";
import { initializeSecrets } from "trestlejs";

export type CreateProjectOptions = {
  cwd: string;
  directory: string;
  install: boolean;
  git: boolean;
  /** Generate the optional platform admin (capabilities.admin). Off by default. */
  admin?: boolean;
  /** Project name; defaults to the directory name, which must then be a valid project name. */
  name?: string;
  run?: (command: string, arguments_: string[], cwd: string) => Promise<void>;
};

export type CreateProjectResult = {
  name: string;
  directory: string;
};

const templateRoot = fileURLToPath(new URL("../template", import.meta.url));
const projectNamePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function render(input: string, projectName: string): string {
  const bucketSource = `${projectName}-worker-artifacts`;
  const artifactBucket = bucketSource.length <= 63 ? bucketSource
    : `${bucketSource.slice(0, 54).replace(/-+$/u, "")}-${createHash("sha256").update(bucketSource).digest("hex").slice(0, 8)}`;
  return input
    .replaceAll("__TRESTLE_ARTIFACT_BUCKET__", artifactBucket)
    .replaceAll("__TRESTLE_PROJECT_NAME__", projectName)
    .replaceAll("__TRESTLEJS_VERSION__", TRESTLEJS_VERSION);
}

async function copyTemplate(source: string, destination: string, projectName: string, baseline: Record<string, string>, enabled: ReadonlySet<OptionalTemplateCapability>, relative = ""): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const outputName = entry.name === "_gitignore" ? ".gitignore" : entry.name;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, outputName);
    const relativePath = path.posix.join(relative, outputName);
    const capability = templatePathCapability(relativePath);
    if (capability && !enabled.has(capability)) continue;
    if (entry.isDirectory()) {
      await copyTemplate(sourcePath, destinationPath, projectName, baseline, enabled, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Template contains unsupported entry: ${sourcePath}`);
    }
    const rendered = render(await readFile(sourcePath, "utf8"), projectName);
    await writeFile(destinationPath, rendered);
    baseline[relativePath] = createHash("sha256").update(rendered).digest("hex");
  }
}

/** Declares enabled optional capabilities in the manifest; each capability and its app path move together. */
async function applyCapabilities(destination: string, baseline: Record<string, string>, enabled: ReadonlySet<OptionalTemplateCapability>): Promise<void> {
  const manifestPath = path.join(destination, ".trestle", "project.yaml");
  const updated = applyManifestCapabilities(await readFile(manifestPath, "utf8"), enabled);
  await writeFile(manifestPath, updated);
  baseline[".trestle/project.yaml"] = createHash("sha256").update(updated).digest("hex");
}

async function defaultRun(command: string, arguments_: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed (${signal ?? `exit ${String(code)}`})`));
    });
  });
}

export async function createProject(options: CreateProjectOptions): Promise<CreateProjectResult> {
  const destination = path.resolve(options.cwd, options.directory);
  const name = options.name ?? path.basename(destination);
  if (!projectNamePattern.test(name)) {
    if (options.name !== undefined) throw new Error("Project name must use lowercase letters, numbers, and single hyphens");
    const suggestion = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
    throw new Error(
      `Project directory name must use lowercase letters, numbers, and single hyphens; choose a project name with --name ${suggestion || "<name>"}`,
    );
  }

  const existed = await pathExists(destination);
  if (existed && (await readdir(destination)).length > 0) {
    throw new Error(`Target directory is not empty: ${destination}`);
  }

  if (!existed) {
    await mkdir(destination, { recursive: false });
  }

  try {
    const baseline: Record<string, string> = {};
    const enabled = new Set<OptionalTemplateCapability>(options.admin ? ["admin"] : []);
    await copyTemplate(templateRoot, destination, name, baseline, enabled);
    if (enabled.size) await applyCapabilities(destination, baseline, enabled);
    await writeFile(path.join(destination, ".trestle", "template-baseline.json"), `${JSON.stringify({ schemaVersion: 1, templateVersion: TRESTLEJS_VERSION, files: Object.fromEntries(Object.entries(baseline).sort(([left], [right]) => left.localeCompare(right))), packageSource: await readFile(path.join(destination, "package.json"), "utf8") }, null, 2)}\n`);
    const manifest = await loadProjectManifest(destination);
    if (manifest.project.name !== name) {
      throw new Error("Rendered project manifest name does not match target directory");
    }
    await initializeSecrets(destination, "local", {
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      BETTER_AUTH_URL: "http://localhost:42069",
      DATABASE_DRIVER: "postgres-js",
      DATABASE_URL: `postgres://trestle:trestle@localhost:55432/${name}`,
    });

    const run = options.run ?? defaultRun;
    if (options.install) {
      await run("pnpm", ["install"], destination);
    }
    if (options.git) {
      await run("git", ["init", "-b", "main"], destination);
    }
    return { name, directory: destination };
  } catch (error) {
    if (!existed) {
      await rm(destination, { recursive: true });
    }
    throw error;
  }
}
