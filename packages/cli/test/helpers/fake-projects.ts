import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A fake `stripe` host with a Projects plugin. State lives under the fake HOME,
 * outside any runner process, so killing a runner never erases simulated
 * remote effects. Every invocation is appended to calls.jsonl.
 */

export type FakeFault = { command: string; stage: "before" | "after"; kind: "crash" | "hang" | "lose-response" | "error"; code?: string; times?: number };

export type FakeRemote = { accountId: string; projects: Record<string, { name: string; environments: Record<string, { resources: Array<{ id: string; name: string; provider: string; service: string; credentialVersion: number; deleted?: boolean }> }> }>; effects: Record<string, number> };

export type FakeBehavior = {
  version?: string;
  faults?: FakeFault[];
  incompleteStatus?: boolean;
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
  remote(): Promise<FakeRemote>;
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
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const remoteFile = path.join(state, "remote.json");
const remote = () => readJson(remoteFile, { accountId: "acct_fake0000001", nextId: 1, projects: {}, effects: {} });
const flag = (name) => { const index = args.indexOf("--" + name); return index === -1 ? undefined : args[index + 1]; };
/** Consumes the next matching fault, so each injected failure fires once. */
function fault(command, stage) {
  const used = readJson(path.join(state, "faults-used.json"), {});
  const faults = behavior.faults || [];
  for (let index = 0; index < faults.length; index += 1) {
    const candidate = faults[index];
    if (candidate.command !== command || candidate.stage !== stage) continue;
    if ((used[index] || 0) >= (candidate.times || 1)) continue;
    used[index] = (used[index] || 0) + 1;
    writeJson(path.join(state, "faults-used.json"), used);
    return candidate;
  }
  return undefined;
}
function applyFault(found, version, command) {
  if (!found) return false;
  if (found.kind === "crash") { process.exit(137); }
  if (found.kind === "hang") { setTimeout(() => {}, 1e9); return true; }
  if (found.kind === "lose-response") { finish(1); return true; }
  if (found.kind === "error") { out({ ok: false, command: "projects " + command, version, error: { code: found.code || "PROVIDER_UNAVAILABLE", message: "injected provider error" } }); finish(1); return true; }
  return false;
}
function workspaceState() { return readJson(".projects/state.json", undefined); }
function activeEnvironment() { return readJson(".projects/state.local.json", { active: "default" }).active; }
function credentialsFor(resource) {
  if (resource.provider === "neon") return { DATABASE_URL: "postgres://owner_" + resource.id + ":pw_v" + resource.credentialVersion + "_secret@ep-" + resource.id.replace(/_/g, "-") + ".us-east-2.aws.neon.tech/neondb?sslmode=require" };
  if (resource.provider === "resend") return { RESEND_API_KEY: "re_fake" + resource.id + "v" + resource.credentialVersion + "ABCDEFGHIJKLMNOP" };
  return { [resource.provider.toUpperCase() + "_TOKEN"]: "tok_" + resource.id + "_v" + resource.credentialVersion };
}
function pullOutputs(data, local) {
  const project = data.projects[local.projectId];
  const environment = activeEnvironment();
  const resources = project.environments[environment].resources.filter((resource) => !resource.deleted);
  const values = Object.assign({}, ...resources.map(credentialsFor));
  const output = local.outputs[environment] || ".env";
  fs.writeFileSync(output, Object.entries(values).map(([key, value]) => key + "=" + JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  fs.chmodSync(output, 0o600);
  fs.mkdirSync(".projects/vault", { recursive: true });
  fs.writeFileSync(".projects/vault/vault.json", JSON.stringify({ encrypted: Buffer.from(JSON.stringify(values)).toString("base64") }));
}
const effect = (data, command) => { data.effects[command] = (data.effects[command] || 0) + 1; };
main();
function main() {
if (args[0] !== "projects") { process.stderr.write("unknown command"); return finish(1); }
if (args.includes("--version")) { process.stdout.write("Stripe Projects v" + (behavior.version || "0.45.0") + "\n"); return finish(0); }
const command = args.slice(1).filter((a, index, all) => !a.startsWith("--") && !(all[index - 1] || "").match(/^--(name|output|account|mode)$/));
const mode = behavior.mode || "ok";
if (mode === "hang") { setTimeout(() => {}, 1e9); return; }
if (mode === "malformed") { process.stdout.write("Neon  free  plan\n"); return finish(0); }
if (mode === "oversize") { process.stdout.write("x".repeat(5_000_000)); return finish(0); }
if (mode === "exit-nonzero") { process.stderr.write("boom sk_live_ABCDEFGH12345678"); return finish(3); }
const version = mode === "wrong-schema" ? "0.2" : "0.1";
const name = command.join(" ");
const authenticated = mode !== "unauthenticated";
if (name.startsWith("catalog") || name.startsWith("search")) {
  fs.mkdirSync(".projects/cache", { recursive: true });
  fs.writeFileSync(".gitignore", ".projects/cache\n.env\n");
  fs.writeFileSync(".projects/cache/catalog.json", "{}");
}
if (mode === "write-env") fs.writeFileSync(".env", "DATABASE_URL=postgres://owner:pw@ep.neon.tech/db\n");
if (mode === "secret-error") { out({ ok: false, command: "projects " + name, version, error: { code: "UNKNOWN_ERROR", message: "failed with token sk_live_ABCDEFGH12345678 at postgres://owner:pw@ep.neon.tech/db" }, meta: { authenticated: true } }); return finish(1); }
if (name.startsWith("catalog")) { out({ ok: true, command: "projects catalog", version, data: (behavior.catalog || {})[command[1]] || { provider: { id: "prvdr_x", name: command[1], capabilities: [], existing_resource_linking: "unsupported" }, services: [] }, meta: { authenticated } }); return finish(0); }
const data = remote();
const local = workspaceState();
if (name === "status") {
  if (!local) { out({ ok: true, command: "projects status", version, data: {}, meta: { authenticated, project_initialized: true } }); return finish(0); }
  if (applyFault(fault("status", "before"), version, name)) return;
  const project = data.projects[local.projectId];
  const environment = activeEnvironment();
  // Mirrors the authenticated 0.45.0 shape (fixtures/stripe-projects/0.45.0/status-with-database.json).
  const display = { neon: "Neon", cloudflare: "Cloudflare", resend: "Resend" };
  const services = [];
  const environments = {};
  for (const [name, env] of Object.entries(project.environments)) {
    const live = env.resources.filter((resource) => !resource.deleted);
    environments[name] = { output: local.outputs[name] || ".env", resources: live.map((resource) => resource.name) };
    for (const resource of live) services.push({ id: resource.id, name: resource.name, provider: display[resource.provider] || resource.provider, service_id: resource.service, status: behavior.incompleteStatus ? "provisioning" : "complete", environments: [name] });
  }
  const plans = (project.plans || []).map((plan) => ({ id: plan.id, provider: display[plan.provider] || plan.provider, service_id: plan.service, status: "complete" }));
  out({ ok: true, command: "projects status", version, data: { project: { id: local.projectId, name: project.name, merchant_id: data.accountId }, active_environment: environment, environments, plans, services: behavior.incompleteStatus ? services.filter((service) => service.environments[0] !== environment).concat(services.filter((service) => service.environments[0] === environment).map((service) => ({ ...service, name: service.name + "-pending" }))) : services }, meta: { authenticated, project_initialized: true } });
  return finish(0);
}
if (!authenticated) { out({ ok: false, command: "projects " + name, version, error: { code: "NOT_AUTHENTICATED", message: "sign in first" }, meta: { authenticated: false } }); return finish(1); }
if (name === "init") {
  if (local) { out({ ok: false, command: "projects init", version, error: { code: "ALREADY_INITIALIZED", message: "already initialized" } }); return finish(1); }
  const projectId = "proj_fake" + String(data.nextId++).padStart(4, "0");
  data.projects[projectId] = { name: path.basename(process.cwd()), environments: { default: { resources: [] } } };
  effect(data, "init");
  writeJson(remoteFile, data);
  fs.mkdirSync(".projects", { recursive: true });
  writeJson(".projects/state.json", { projectId, outputs: { default: ".env" } });
  writeJson(".projects/state.local.json", { active: "default" });
  out({ ok: true, command: "projects init", version, data: { project: { id: projectId } } });
  return finish(0);
}
if (!local) { out({ ok: false, command: "projects " + name, version, error: { code: "NO_PROJECT_CONFIG", message: "No project initialized in this directory." } }); return finish(1); }
const project = data.projects[local.projectId];
if (command[0] === "env" && command[1] === "create") {
  project.environments[command[2]] = project.environments[command[2]] || { resources: [] };
  local.outputs[command[2]] = flag("output") || (".env." + command[2]);
  writeJson(".projects/state.json", local);
  writeJson(".projects/state.local.json", { active: command[2] });
  writeJson(remoteFile, data);
  out({ ok: true, command: "projects env create", version, data: { environment: command[2] } });
  return finish(0);
}
if (command[0] === "env" && command[1] === "use") {
  if (!project.environments[command[2]]) { out({ ok: false, command: "projects env use", version, error: { code: "UNKNOWN_ENVIRONMENT", message: "no such environment" } }); return finish(1); }
  writeJson(".projects/state.local.json", { active: command[2] });
  out({ ok: true, command: "projects env use", version, data: { environment: command[2] } });
  return finish(0);
}
if (command[0] === "env" && args.includes("--pull")) {
  if (applyFault(fault("env pull", "before"), version, name)) return;
  pullOutputs(data, local);
  out({ ok: true, command: "projects env", version, data: { pulled: true } });
  return finish(0);
}
if (command[0] === "add") {
  if (applyFault(fault("add", "before"), version, name)) return;
  const [provider, service] = command[1].split("/");
  if (/^(free|launch|pro|workers:free|workers:paid)$/.test(service)) {
    project.plans = project.plans || [];
    if (project.plans.some((plan) => plan.provider === provider && plan.service === service)) { out({ ok: false, command: "projects add", version, error: { code: "resource_count_constraint_exceeded", message: "plan exists" } }); return finish(1); }
    project.plans.push({ id: provider + "_plan" + String(data.nextId++).padStart(4, "0"), provider, service });
    effect(data, "addPlan");
    writeJson(remoteFile, data);
    out({ ok: true, command: "projects add", version, data: { service: { key: project.plans.at(-1).id, name: provider + "-plan", provider, service_id: service, status: "complete" } } });
    return finish(0);
  }
  const environment = activeEnvironment();
  const resource = { id: provider + "_res" + String(data.nextId++).padStart(4, "0"), name: flag("name") || service, provider, service, credentialVersion: 1 };
  project.environments[environment].resources.push(resource);
  effect(data, "add");
  writeJson(remoteFile, data);
  if (applyFault(fault("add", "after"), version, name)) return;
  pullOutputs(data, local);
  out({ ok: true, command: "projects add", version, data: { files_modified: [".projects/vault/vault.json", local.outputs[environment] || ".env"], service: { key: resource.id, name: resource.name, provider, service_id: service, status: "complete" } } });
  return finish(0);
}
if (command[0] === "rotate") {
  if (applyFault(fault("rotate", "before"), version, name)) return;
  const resource = project.environments[activeEnvironment()].resources.find((candidate) => candidate.name === command[1] && !candidate.deleted);
  if (!resource) { out({ ok: false, command: "projects rotate", version, error: { code: "RESOURCE_NOT_FOUND", message: "no such resource" } }); return finish(1); }
  resource.credentialVersion += 1;
  effect(data, "rotate");
  writeJson(remoteFile, data);
  if (applyFault(fault("rotate", "after"), version, name)) return;
  pullOutputs(data, local);
  out({ ok: true, command: "projects rotate", version, data: { resource: { id: resource.id, name: resource.name } } });
  return finish(0);
}
if (command[0] === "remove") {
  const resource = project.environments[activeEnvironment()].resources.find((candidate) => candidate.name === command[1] && !candidate.deleted);
  if (!resource) { out({ ok: false, command: "projects remove", version, error: { code: "RESOURCE_NOT_FOUND", message: "no such resource" } }); return finish(1); }
  resource.deleted = true;
  effect(data, "remove");
  writeJson(remoteFile, data);
  out({ ok: true, command: "projects remove", version, data: { resource: { id: resource.id } } });
  return finish(0);
}
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
    remote: async () => JSON.parse(await readFile(path.join(state, "remote.json"), "utf8").catch(() => '{"accountId":"acct_fake0000001","projects":{},"effects":{}}')) as FakeRemote,
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
