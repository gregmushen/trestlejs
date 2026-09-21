import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedVersion = process.argv[2];
const repositoryUrl = "git+https://github.com/gregmushen/trestlejs.git";
const packages = [
  ["packages/core", "@trestlejs/core"],
  ["packages/cli", "trestlejs"],
  ["packages/create", "create-trestlejs"],
];

const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(root, relativePath), "utf8"));

const workspace = await readJson("package.json");
if (workspace.private !== true) {
  throw new Error("The workspace root must remain private.");
}

const manifests = await Promise.all(
  packages.map(async ([directory, name]) => {
    const manifest = await readJson(`${directory}/package.json`);
    if (manifest.name !== name) throw new Error(`${directory} must be named ${name}.`);
    if (manifest.private === true) throw new Error(`${name} is still private.`);
    if (manifest.license !== "MIT") throw new Error(`${name} must declare the MIT license.`);
    if (manifest.repository?.url !== repositoryUrl) {
      throw new Error(`${name} repository URL must exactly match ${repositoryUrl}.`);
    }
    if (manifest.publishConfig?.access !== "public") {
      throw new Error(`${name} must publish with public access.`);
    }
    return manifest;
  }),
);

const versions = new Set(manifests.map(({ version }) => version));
if (versions.size !== 1) throw new Error("All publishable packages must use the same version.");

const [version] = versions;
if (expectedVersion && version !== expectedVersion) {
  throw new Error(`Release tag version ${expectedVersion} does not match package version ${version}.`);
}

const versionSource = await readFile(path.join(root, "packages/core/src/version.ts"), "utf8");
if (!versionSource.includes(`TRESTLEJS_VERSION = "${version}"`)) {
  throw new Error(`TRESTLEJS_VERSION must match package version ${version}.`);
}

console.log(`Release metadata valid for TrestleJS ${version}.`);
