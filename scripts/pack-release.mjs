import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = path.join(root, "release");
const packages = [
  ["packages/core", "trestlejs-core.tgz"],
  ["packages/cli", "trestlejs.tgz"],
  ["packages/create", "create-trestlejs.tgz"],
];

await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });

for (const [directory, archive] of packages) {
  const result = spawnSync(
    "pnpm",
    ["--dir", directory, "pack", "--out", path.join(releaseDirectory, archive)],
    { cwd: root, encoding: "utf8", stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const [, archive] of packages) {
  const archivePath = path.join(releaseDirectory, archive);
  const result = spawnSync("tar", ["-xOf", archivePath, "package/package.json"], {
    encoding: "utf8",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const manifest = JSON.parse(result.stdout);
  const serialized = JSON.stringify(manifest);
  if (serialized.includes("workspace:")) {
    throw new Error(`${archive} contains an unresolved workspace dependency.`);
  }
  if (manifest.private === true) throw new Error(`${archive} is marked private.`);
  await readFile(archivePath);
  console.log(`Verified ${archive}: ${manifest.name}@${manifest.version}`);
}
