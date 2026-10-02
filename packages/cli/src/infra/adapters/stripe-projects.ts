import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { COMMAND_EFFECTS, isRemoteReadOnly, SUPPORTED_TOOLCHAIN, type CommandEffect, type Toolchain } from "../capabilities.js";
import type { Observation } from "../schema.js";
import { sha256 } from "../canonical.js";
import type { ProcessRunner } from "../process.js";
import { redact } from "../redaction.js";

/**
 * Versioned translation to the Stripe Projects CLI (plan P03). The plugin is a
 * gRPC server driven by the `stripe` host, so the adapter runs the host by
 * absolute path and verifies the plugin executable it will load.
 */

export type ToolchainLocation = Readonly<{ stripePath: string; pluginRoot: string; home: string }>;

export type VerifiedToolchain = Toolchain & Readonly<{ stripePath: string; stripeSha256: string; pluginPath: string }>;

export type ToolchainCheck =
  | Readonly<{ ok: true; toolchain: VerifiedToolchain }>
  | Readonly<{ ok: false; reasons: readonly string[] }>;

export function defaultToolchainLocation(environment: (name: string) => string | undefined): ToolchainLocation {
  const home = environment("HOME") ?? os.homedir();
  return {
    home,
    stripePath: environment("TRESTLE_PROJECTS_STRIPE_PATH") ?? (process.platform === "darwin" ? "/opt/homebrew/bin/stripe" : "/usr/local/bin/stripe"),
    pluginRoot: environment("TRESTLE_PROJECTS_PLUGIN_ROOT") ?? path.join(home, ".config", "stripe", "plugins", "projects"),
  };
}

async function trustedFile(filePath: string, label: string, reasons: string[]): Promise<string | undefined> {
  if (!path.isAbsolute(filePath)) {
    reasons.push(`${label} must be an absolute path`);
    return undefined;
  }
  try {
    const resolved = await realpath(filePath);
    const info = await stat(resolved);
    if (!info.isFile()) reasons.push(`${label} is not a regular file`);
    if ((info.mode & 0o022) !== 0) reasons.push(`${label} is writable by group or others`);
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid && info.uid !== 0) reasons.push(`${label} is owned by another user`);
    return resolved;
  } catch {
    reasons.push(`${label} not found at ${filePath}`);
    return undefined;
  }
}

/**
 * Verifies the host binary location and the pinned plugin executable. Any
 * mismatch returns reasons and no toolchain, which callers treat as unknown.
 */
export async function verifyToolchain(location: ToolchainLocation, runner: ProcessRunner, expected: Toolchain = SUPPORTED_TOOLCHAIN): Promise<ToolchainCheck> {
  const reasons: string[] = [];
  const stripePath = await trustedFile(location.stripePath, "stripe CLI", reasons);
  const pluginPath = await trustedFile(path.join(location.pluginRoot, expected.pluginVersion, "stripe-cli-projects"), `Projects plugin ${expected.pluginVersion}`, reasons);
  if (!stripePath || !pluginPath) return { ok: false, reasons };
  const [stripeBytes, pluginBytes] = await Promise.all([readFile(stripePath), readFile(pluginPath)]);
  const pluginSha256 = sha256(pluginBytes);
  if (pluginSha256 !== expected.pluginSha256) reasons.push(`Projects plugin hash ${pluginSha256.slice(0, 12)}… does not match the qualified executable`);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "trestle-projects-version-"));
  try {
    const result = await runner.run({ executable: stripePath, args: ["projects", "--version"], cwd: scratch, env: minimalEnvironment(location), timeoutMs: 30_000, maxOutputBytes: 4096 });
    const version = /(\d+\.\d+\.\d+)/u.exec(result.stdout)?.[1];
    if (result.exitCode !== 0 || !version) reasons.push("could not read the active Projects plugin version");
    else if (version !== expected.pluginVersion) reasons.push(`active Projects plugin is ${version}; qualified version is ${expected.pluginVersion}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, toolchain: { ...expected, pluginSha256, stripePath, stripeSha256: sha256(stripeBytes), pluginPath } };
}

/** Only what the host needs: no developer environment, credentials or debug flags. */
function minimalEnvironment(location: ToolchainLocation): Record<string, string> {
  return { HOME: location.home, PATH: "/usr/bin:/bin", STRIPE_CLI_TELEMETRY_OPTOUT: "1", NO_COLOR: "1" };
}

const envelopeSchema = z.object({
  ok: z.boolean(),
  command: z.string(),
  version: z.string(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string().regex(/^[A-Z0-9_]{1,64}$/u), message: z.string() }).optional(),
  meta: z.object({ authenticated: z.boolean().optional(), project_initialized: z.boolean().optional() }).passthrough().optional(),
}).passthrough();

export type ProjectsResult<T> =
  | Readonly<{ status: "ok"; data: T; authenticated: boolean | null }>
  | Readonly<{ status: "provider_error"; code: string; message: string; authenticated: boolean | null }>
  | Readonly<{ status: "failure"; reason: string }>;

export class ProjectsAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectsAdapterError";
  }
}

/** Files a read command may leave in its scratch directory; anything else is an unexpected effect. */
const ALLOWED_READ_ARTIFACTS = [/^\.gitignore$/u, /^\.projects$/u, /^\.projects\/cache$/u, /^\.projects\/cache\/[a-z0-9._-]+\.json$/u];

async function listTree(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    results.push(relative);
    if (entry.isDirectory()) results.push(...await listTree(root, relative));
  }
  return results;
}

const catalogSchema = z.object({
  provider: z.object({ id: z.string(), name: z.string(), capabilities: z.array(z.string()), existing_resource_linking: z.string() }).passthrough(),
  plans: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u), provider: z.string().min(1), service_id: z.string().min(1), status: z.string() }).passthrough()).default([]),
  services: z.array(z.object({ service_id: z.string(), kind: z.string(), scope: z.string(), availability: z.string(), pricing: z.object({ type: z.string() }).passthrough(), updateable_to: z.array(z.string()).default([]) }).passthrough()),
}).passthrough();

export type ProjectsCatalog = Readonly<{
  provider: Readonly<{ id: string; name: string; capabilities: readonly string[]; existingResourceLinking: string }>;
  services: ReadonlyArray<Readonly<{ serviceId: string; kind: string; scope: string; availability: string; pricing: string; updateableTo: readonly string[] }>>;
}>;

export class StripeProjectsAdapter {
  constructor(
    private readonly toolchain: VerifiedToolchain,
    private readonly location: ToolchainLocation,
    private readonly runner: ProcessRunner,
    private readonly maxOutputBytes = 2_000_000,
  ) {}

  /**
   * Runs one read-only command in a fresh scratch directory and removes it.
   * Mutating commands are refused here; they go through the executor.
   */
  async read(command: string, positionals: readonly string[] = [], workspace?: string): Promise<ProjectsResult<unknown>> {
    if (!(command in COMMAND_EFFECTS) || !isRemoteReadOnly(command)) throw new ProjectsAdapterError(`${command} is not a read-only Projects command`);
    const scratch = workspace ?? await mkdtemp(path.join(os.tmpdir(), "trestle-projects-"));
    const before = workspace ? new Set(await listTree(scratch)) : new Set<string>();
    try {
      const result = await this.runner.run({
        executable: this.toolchain.stripePath,
        args: ["projects", ...command.split(" "), ...positionals, "--json", "--non-interactive"],
        cwd: scratch, env: minimalEnvironment(this.location), timeoutMs: 60_000, maxOutputBytes: this.maxOutputBytes,
      });
      if (result.timedOut) return { status: "failure", reason: `projects ${command} timed out` };
      if (result.truncated) return { status: "failure", reason: `projects ${command} output exceeded ${this.maxOutputBytes} bytes` };
      const unexpected = (await listTree(scratch)).filter((entry) => !before.has(entry) && !ALLOWED_READ_ARTIFACTS.some((pattern) => pattern.test(entry)));
      if (unexpected.length > 0) return { status: "failure", reason: `projects ${command} wrote unexpected files: ${unexpected.map((entry) => redact(entry)).join(", ")}` };
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return { status: "failure", reason: `projects ${command} did not return JSON (exit ${String(result.exitCode)}): ${redact(result.stderr).slice(0, 200)}` };
      }
      const envelope = envelopeSchema.safeParse(parsed);
      if (!envelope.success) return { status: "failure", reason: `projects ${command} returned an unrecognized envelope` };
      if (envelope.data.version !== this.toolchain.envelopeVersion) return { status: "failure", reason: `projects ${command} returned schema ${envelope.data.version}; expected ${this.toolchain.envelopeVersion}` };
      const authenticated = envelope.data.meta?.authenticated ?? null;
      if (!envelope.data.ok) {
        const error = envelope.data.error;
        return error ? { status: "provider_error", code: error.code, message: redact(error.message).slice(0, 300), authenticated } : { status: "failure", reason: `projects ${command} failed without an error code` };
      }
      return { status: "ok", data: envelope.data.data, authenticated };
    } finally {
      if (!workspace) await rm(scratch, { recursive: true, force: true });
    }
  }

  async catalog(provider: string): Promise<ProjectsResult<ProjectsCatalog>> {
    if (!/^[a-z][a-z0-9-]{0,40}$/u.test(provider)) throw new ProjectsAdapterError("provider must be a lowercase identifier");
    const result = await this.read("catalog", [provider]);
    if (result.status !== "ok") return result;
    const parsed = catalogSchema.safeParse(result.data);
    if (!parsed.success) return { status: "failure", reason: "catalog data did not match the qualified schema" };
    const { provider: found, services } = parsed.data;
    return {
      status: "ok", authenticated: result.authenticated,
      data: {
        provider: { id: found.id, name: found.name, capabilities: found.capabilities, existingResourceLinking: found.existing_resource_linking },
        services: services.map((service) => ({ serviceId: service.service_id, kind: service.kind, scope: service.scope, availability: service.availability, pricing: service.pricing.type, updateableTo: service.updateable_to })),
      },
    };
  }

  /**
   * Runs one approved mutating command in the environment's isolated workspace.
   * Every recorded effect of the command must be covered by the approval.
   * Outcomes distinguish a definitive provider answer from an unknown one: a
   * timeout, crash or lost response never counts as "did not happen".
   */
  async mutate(command: string, positionals: readonly string[], flags: Readonly<Record<string, string | true>>, workspace: string, approvedEffects: readonly CommandEffect[]): Promise<MutationOutcome> {
    const effects = COMMAND_EFFECTS[command];
    if (!effects || isRemoteReadOnly(command)) throw new ProjectsAdapterError(`${command} is not a recorded mutating Projects command`);
    const missing = effects.filter((effect) => !approvedEffects.includes(effect));
    if (missing.length) throw new ProjectsAdapterError(`projects ${command} has unapproved effects: ${missing.join(", ")}`);
    const allowedFlags = new Set(["name", "output", "skip-skills", "skip-install", "mode", "account", "yes"]);
    const flagArgs: string[] = [];
    for (const [flag, value] of Object.entries(flags)) {
      if (!allowedFlags.has(flag)) throw new ProjectsAdapterError(`flag --${flag} is not permitted`);
      flagArgs.push(`--${flag}`, ...(value === true ? [] : [value]));
    }
    const verb = command === "env pull" ? ["env", "--pull"] : command.split(" ");
    const result = await this.runner.run({
      executable: this.toolchain.stripePath,
      args: ["projects", ...verb, ...positionals, ...flagArgs, "--json", "--non-interactive"],
      cwd: workspace, env: minimalEnvironment(this.location), timeoutMs: 300_000, maxOutputBytes: this.maxOutputBytes,
    });
    if (result.timedOut) return { status: "unknown", reason: `projects ${command} timed out; the provider may still complete it` };
    if (result.truncated) return { status: "unknown", reason: `projects ${command} output exceeded the bound` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { status: "unknown", reason: `projects ${command} returned no parseable response (exit ${String(result.exitCode)}${result.signal ? `, ${result.signal}` : ""})` };
    }
    const envelope = envelopeSchema.safeParse(parsed);
    if (!envelope.success || envelope.data.version !== this.toolchain.envelopeVersion) return { status: "unknown", reason: `projects ${command} returned an unrecognized envelope` };
    if (!envelope.data.ok) {
      const error = envelope.data.error;
      return error ? { status: "rejected", code: error.code, message: redact(error.message).slice(0, 300) } : { status: "unknown", reason: `projects ${command} failed without an error code` };
    }
    return { status: "ok", data: envelope.data.data };
  }

  /**
   * Reads the workspace's active Projects environment and resources.
   * The status data shape is implemented against the fake provider; the real
   * 0.45.0 authenticated shape is unverified (no hosted access), so live use is
   * additionally gated by capability evidence.
   */
  async observe(workspace: string, now: Date): Promise<ObservationResult> {
    const result = await this.read("status", [], workspace);
    if (result.status === "failure") return { status: "unknown", reason: result.reason };
    if (result.status === "provider_error") return { status: "unknown", reason: `${result.code}: ${result.message}` };
    if (result.authenticated === false) return { status: "unknown", reason: "Projects session is not authenticated" };
    return parseStatus(result.data, now);
  }
}


/** Maps authenticated `projects status` data to an observation; unknown shapes are unknown, never empty. */
export function parseStatus(input: unknown, now: Date): ObservationResult {
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { status: "unknown", reason: "status data did not match the expected schema" };
  const data = parsed.data;
  const known = new Set(["neon", "cloudflare", "resend"]);
  // Services in the active environment; plans are listed separately and are not resources.
  const services = data.services.filter((service) => service.environments.includes(data.active_environment));
  const unknownProviders = services.filter((service) => !known.has(service.provider.toLowerCase()));
  return {
    status: "ok",
    observation: {
      observedAt: now.toISOString(), stripeAccountId: data.project.merchant_id, projectsProjectId: data.project.id, projectsEnvironment: data.active_environment,
      resources: services.filter((service) => known.has(service.provider.toLowerCase())).map((service) => ({ externalId: service.id, provider: service.provider.toLowerCase() as Observation["resources"][number]["provider"], service: service.service_id, name: service.name })),
      plans: data.plans.filter((plan) => known.has(plan.provider.toLowerCase()) && plan.status === "complete").map((plan) => ({ provider: plan.provider.toLowerCase() as Observation["resources"][number]["provider"], service: plan.service_id, externalId: plan.id })),
      // A listing with services Trestle cannot classify, or still pending, is not proof of absence.
      complete: unknownProviders.length === 0 && services.every((service) => service.status === "complete"),
    },
  };
}

/** Authenticated `projects status --json` data at plugin 0.45.0 (observed 2026-10-02). */
const statusSchema = z.object({
  project: z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u), merchant_id: z.string().regex(/^acct_[A-Za-z0-9]{6,}$/u) }).passthrough(),
  active_environment: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
  environments: z.record(z.string(), z.object({ output: z.string(), resources: z.array(z.string()) }).passthrough()),
  plans: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u), provider: z.string().min(1), service_id: z.string().min(1), status: z.string() }).passthrough()).default([]),
  services: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u),
    name: z.string().max(200),
    provider: z.string().min(1),
    service_id: z.string().min(1),
    status: z.string(),
    environments: z.array(z.string()).default([]),
  }).passthrough()),
}).passthrough();

export type MutationOutcome =
  | Readonly<{ status: "ok"; data: unknown }>
  | Readonly<{ status: "rejected"; code: string; message: string }>
  | Readonly<{ status: "unknown"; reason: string }>;

export type ObservationResult = Readonly<{ status: "ok"; observation: Observation }> | Readonly<{ status: "unknown"; reason: string }>;

/** The adapter surface the executor depends on. */
export type MutatingAdapter = Pick<StripeProjectsAdapter, "mutate" | "observe">;
