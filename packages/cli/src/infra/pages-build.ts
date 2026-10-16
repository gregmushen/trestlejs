import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pagesWranglerDigest } from "./pages-host.js";
import { nodeProcessRunner, type ProcessRunner } from "./process.js";

/** Compile Functions without deploy/GitHub credentials. The exclusive config
 * redirect selects Pages configuration when the app also has a Worker config.
 * Existing output/redirects are never overwritten; build the frontend afresh
 * before rebuilding its Functions. */
export async function buildPagesFunctions(appRoot: string, binary: string, runner: ProcessRunner = nodeProcessRunner): Promise<{ built: boolean }> {
  await pagesWranglerDigest(binary);
  const functions = await lstat(path.join(appRoot, "functions")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!functions) return { built: false };
  if (!functions.isDirectory() || functions.isSymbolicLink()) throw new Error("Pages Functions must be a real directory");
  await readFile(path.join(appRoot, "wrangler.pages.jsonc"));
  const dist = path.join(appRoot, "dist");
  if (!(await lstat(dist)).isDirectory()) throw new Error("build the frontend before Functions");
  const target = path.join(dist, "_worker.js");
  if (await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("dist/_worker.js already exists; rebuild the frontend before Functions");
  const redirectDirectory = path.join(appRoot, ".wrangler/deploy");
  await mkdir(redirectDirectory, { recursive: true });
  const redirect = path.join(redirectDirectory, "config.json");
  await writeFile(redirect, JSON.stringify({ configPath: "../../wrangler.pages.jsonc" }), { flag: "wx", mode: 0o600 });
  let scratch: string | undefined;
  let createdTarget = false;
  try {
    scratch = await mkdtemp(path.join(os.tmpdir(), "trestle-pages-build-"));
    const out = path.join(scratch, "output");
    const result = await runner.run({ executable: process.execPath, args: [binary, "pages", "functions", "build", "functions", "--outdir", out], cwd: appRoot, env: { HOME: scratch, PATH: "/usr/bin:/bin", WRANGLER_SEND_METRICS: "false", CI: "true" }, timeoutMs: 120_000, maxOutputBytes: 2_000_000 });
    if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new Error("Pages Functions compilation failed; no deployment was attempted");
    await mkdir(target); createdTarget = true;
    for (const name of await readdir(out)) await cp(path.join(out, name), path.join(target, name), { recursive: true, force: false, errorOnExist: true });
    return { built: true };
  } catch (error) {
    if (createdTarget) await rm(target, { recursive: true, force: true });
    throw error;
  } finally {
    await unlink(redirect);
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
