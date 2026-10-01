import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A fake `stripe` host with a Projects plugin. State lives under the fake HOME,
 * outside any runner process, so killing a runner never erases simulated
 * remote effects. Every invocation is appended to calls.jsonl.
 */

export type FakeBehavior = {
  version?: string;
  mode?: "ok" | "malformed" | "oversize" | "hang" | "wrong-schema" | "secret-error" | "write-env" | "unauthenticated" | "exit-nonzero";
  catalog?: Record<string, unknown>;
};

export type FakeCall = { args: string[]; cwd: string; env: string[] };

export type FakeProjects = {
  home: string;
  stripePath: string;
  pluginRoot: string;
  pluginSha256: string;
  setBehavior(behavior: FakeBehavior): Promise<void>;
  calls(): Promise<FakeCall[]>;
  environment(): Record<string, string>;
  cleanup(): Promise<void>;
};

const SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const state = path.join(process.env.HOME, "fake-projects");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env).sort() }) + "\n");
const behavior = JSON.parse(fs.readFileSync(path.join(state, "behavior.json"), "utf8"));
const out = (value) => process.stdout.write(JSON.stringify(value));
const finish = (code) => { process.exitCode = code; };
main();
function main() {
if (args[0] !== "projects") { process.stderr.write("unknown command"); return finish(1); }
if (args.includes("--version")) { process.stdout.write("Stripe Projects v" + (behavior.version || "0.45.0") + "\n"); return finish(0); }
const command = args.slice(1).filter((a) => !a.startsWith("--"));
const mode = behavior.mode || "ok";
if (mode === "hang") { setTimeout(() => {}, 1e9); return; }
if (mode === "malformed") { process.stdout.write("Neon  free  plan\n"); return finish(0); }
if (mode === "oversize") { process.stdout.write("x".repeat(5_000_000)); return finish(0); }
if (mode === "exit-nonzero") { process.stderr.write("boom sk_live_ABCDEFGH12345678"); return finish(3); }
fs.mkdirSync(".projects/cache", { recursive: true });
fs.writeFileSync(".gitignore", ".projects/cache\n.env\n");
fs.writeFileSync(".projects/cache/catalog.json", "{}");
if (mode === "write-env") fs.writeFileSync(".env", "DATABASE_URL=postgres://owner:pw@ep.neon.tech/db\n");
const version = mode === "wrong-schema" ? "0.2" : "0.1";
const name = command.join(" ");
if (mode === "secret-error") { out({ ok: false, command: "projects " + name, version, error: { code: "UNKNOWN_ERROR", message: "failed with token sk_live_ABCDEFGH12345678 at postgres://owner:pw@ep.neon.tech/db" }, meta: { authenticated: true } }); return finish(1); }
if (name.startsWith("catalog")) { out({ ok: true, command: "projects catalog", version, data: (behavior.catalog || {})[command[1]] || { provider: { id: "prvdr_x", name: command[1], capabilities: [], existing_resource_linking: "unsupported" }, services: [] }, meta: { authenticated: mode !== "unauthenticated" } }); return finish(0); }
if (name === "status") { out({ ok: true, command: "projects status", version, data: {}, meta: { authenticated: mode !== "unauthenticated", project_initialized: true } }); return finish(0); }
out({ ok: false, command: "projects " + name, version, error: { code: "UNSUPPORTED_FAKE", message: "fake does not implement " + name } });
return finish(1);
}
`;

export async function createFakeProjects(): Promise<FakeProjects> {
  const home = await mkdtemp(path.join(os.tmpdir(), "trestle-fake-projects-"));
  const state = path.join(home, "fake-projects");
  const bin = path.join(home, "bin");
  const pluginRoot = path.join(home, ".config", "stripe", "plugins", "projects");
  await mkdir(state, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(pluginRoot, "0.45.0"), { recursive: true });
  const stripePath = path.join(bin, "stripe");
  await writeFile(stripePath, `#!${process.execPath}\n${SCRIPT}`, { mode: 0o755 });
  await chmod(stripePath, 0o755);
  const plugin = Buffer.from("fake plugin executable\n");
  await writeFile(path.join(pluginRoot, "0.45.0", "stripe-cli-projects"), plugin, { mode: 0o755 });
  await writeFile(path.join(state, "behavior.json"), "{}");
  await writeFile(path.join(state, "calls.jsonl"), "");
  const pluginSha256 = createHash("sha256").update(plugin).digest("hex");
  return {
    home, stripePath, pluginRoot, pluginSha256,
    setBehavior: (behavior) => writeFile(path.join(state, "behavior.json"), JSON.stringify(behavior)),
    calls: async () => (await readFile(path.join(state, "calls.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeCall),
    environment: () => ({ HOME: home, TRESTLE_PROJECTS_STRIPE_PATH: stripePath, TRESTLE_PROJECTS_PLUGIN_ROOT: pluginRoot, TRESTLE_PROJECTS_PLUGIN_SHA256: pluginSha256 }),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

/** Commands (ignoring flags) that are not read-only. */
export function mutatingCalls(calls: readonly FakeCall[]): string[] {
  const reads = new Set(["catalog", "search", "status", "list", "services list", "env list", "env show"]);
  return calls.map((call) => call.args.slice(1).filter((argument) => !argument.startsWith("--")))
    .filter((command) => command.length > 0)
    .map((command) => (command[0] === "services" || command[0] === "env" ? command.slice(0, 2).join(" ") : command[0]!))
    .filter((command) => !reads.has(command));
}
