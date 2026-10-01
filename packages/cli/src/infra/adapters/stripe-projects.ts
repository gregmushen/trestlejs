import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { COMMAND_EFFECTS, isRemoteReadOnly, SUPPORTED_TOOLCHAIN, type Toolchain } from "../capabilities.js";
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
}
