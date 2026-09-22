import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "trestle-release-canary-"));
const project = path.join(temporaryRoot, "release-canary");

async function run(command, arguments_, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} ${arguments_.join(" ")} failed (${signal ?? `exit ${code}`})`)));
  });
}

try {
  await run(process.execPath, [path.join(root, "packages/create/dist/bin.js"), project, "--no-git"], root);
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "generate", "resource", "Article"], project);
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "ci", "validate"], project);
  await run("pnpm", ["check"], project);
  console.log(`Generated release canary passed at ${project}`);
} finally {
  await rm(temporaryRoot, { recursive: true });
}
