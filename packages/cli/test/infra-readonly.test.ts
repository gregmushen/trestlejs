import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";
import { ProjectsAdapterError, StripeProjectsAdapter, verifyToolchain } from "../src/infra/adapters/stripe-projects.js";
import { SUPPORTED_TOOLCHAIN } from "../src/infra/capabilities.js";
import { validateApiEndpoint, validatePostgresEndpoint } from "../src/infra/endpoints.js";
import { nodeProcessRunner } from "../src/infra/process.js";
import { createFakeProjects, mutatingCalls, type FakeProjects } from "./helpers/fake-projects.js";

let fake: FakeProjects;
const directories: string[] = [];
beforeEach(async () => { fake = await createFakeProjects(); });
afterEach(async () => {
  await fake.cleanup();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const location = () => ({ stripePath: fake.stripePath, pluginRoot: fake.pluginRoot, home: fake.home });
const expected = () => ({ ...SUPPORTED_TOOLCHAIN, pluginSha256: fake.pluginSha256 });

async function adapter(): Promise<StripeProjectsAdapter> {
  const check = await verifyToolchain(location(), nodeProcessRunner, expected());
  if (!check.ok) throw new Error(check.reasons.join("; "));
  return new StripeProjectsAdapter(check.toolchain, location(), nodeProcessRunner, 1_000_000);
}

describe("Projects toolchain verification", () => {
  it("accepts the pinned plugin and reports the host binary", async () => {
    const check = await verifyToolchain(location(), nodeProcessRunner, expected());
    expect(check).toMatchObject({ ok: true, toolchain: { pluginVersion: "0.45.0", stripePath: expect.stringContaining("stripe") } });
  });

  it("rejects the real qualified hash when a different plugin build is installed", async () => {
    const check = await verifyToolchain(location(), nodeProcessRunner);
    expect(check.ok).toBe(false);
    expect(check.ok ? [] : check.reasons).toEqual([expect.stringMatching(/hash .* does not match/u)]);
  });

  it("rejects relative, missing and writable executables (path hijack)", async () => {
    expect(await verifyToolchain({ ...location(), stripePath: "stripe" }, nodeProcessRunner, expected())).toMatchObject({ ok: false, reasons: [expect.stringMatching(/absolute path/u)] });
    expect(await verifyToolchain({ ...location(), stripePath: path.join(fake.home, "missing") }, nodeProcessRunner, expected())).toMatchObject({ ok: false });
    await chmod(fake.stripePath, 0o777);
    expect(await verifyToolchain(location(), nodeProcessRunner, expected())).toMatchObject({ ok: false, reasons: [expect.stringMatching(/writable by group or others/u)] });
  });

  it("rejects a different active plugin version", async () => {
    await fake.setBehavior({ version: "0.46.0" });
    const check = await verifyToolchain(location(), nodeProcessRunner, expected());
    expect(check).toMatchObject({ ok: false, reasons: [expect.stringMatching(/active Projects plugin is 0.46.0/u)] });
  });
});

describe("read-only Projects adapter", () => {
  it("refuses mutating commands without starting a process", async () => {
    const projects = await adapter();
    const before = (await fake.calls()).length;
    for (const command of ["add", "rotate", "remove", "link", "init", "upgrade", "env pull", "env add", "share"]) {
      await expect(projects.read(command)).rejects.toThrow(ProjectsAdapterError);
    }
    expect((await fake.calls()).length).toBe(before);
  });

  it("runs reads in a removed scratch directory with a minimal environment", async () => {
    const projects = await adapter();
    const result = await projects.catalog("neon");
    expect(result.status).toBe("ok");
    const call = (await fake.calls()).at(-1)!;
    expect(call.args).toEqual(["projects", "catalog", "neon", "--json", "--non-interactive"]);
    expect(call.env.filter((key) => !key.startsWith("__CF"))).toEqual(["HOME", "NO_COLOR", "PATH", "STRIPE_CLI_TELEMETRY_OPTOUT"]);
    await expect(stat(call.cwd)).rejects.toThrow();
  });

  it("fails closed on malformed, oversize, non-zero and drifted-schema output", async () => {
    const projects = await adapter();
    await fake.setBehavior({ mode: "malformed" });
    expect(await projects.read("catalog", ["neon"])).toMatchObject({ status: "failure", reason: expect.stringMatching(/did not return JSON/u) });
    await fake.setBehavior({ mode: "oversize" });
    expect(await projects.read("catalog", ["neon"])).toMatchObject({ status: "failure", reason: expect.stringMatching(/exceeded/u) });
    await fake.setBehavior({ mode: "wrong-schema" });
    expect(await projects.read("catalog", ["neon"])).toMatchObject({ status: "failure", reason: expect.stringMatching(/schema 0.2/u) });
    await fake.setBehavior({ mode: "exit-nonzero" });
    const failed = await projects.read("catalog", ["neon"]);
    expect(failed.status).toBe("failure");
    expect(JSON.stringify(failed)).not.toContain("sk_live_ABCDEFGH12345678");
  });

  it("redacts credentials nested in provider errors", async () => {
    const projects = await adapter();
    await fake.setBehavior({ mode: "secret-error" });
    const result = await projects.read("status");
    expect(result).toMatchObject({ status: "provider_error", code: "UNKNOWN_ERROR" });
    expect(JSON.stringify(result)).not.toMatch(/sk_live_ABCDEFGH12345678|owner:pw/u);
  });

  it("treats an unexpected plaintext credential write by a read command as a failure", async () => {
    const projects = await adapter();
    await fake.setBehavior({ mode: "write-env" });
    const result = await projects.read("catalog", ["neon"]);
    expect(result).toMatchObject({ status: "failure", reason: expect.stringMatching(/unexpected files: \.env/u) });
    expect(JSON.stringify(result)).not.toContain("owner:pw");
  });

  it("times out a hung provider command", async () => {
    await fake.setBehavior({ mode: "hang" });
    const check = await verifyToolchain(location(), nodeProcessRunner, expected());
    if (!check.ok) throw new Error("toolchain");
    const slow = { run: (spec: Parameters<typeof nodeProcessRunner.run>[0]) => nodeProcessRunner.run({ ...spec, timeoutMs: 300 }) };
    const result = await new StripeProjectsAdapter(check.toolchain, location(), slow).read("status");
    expect(result).toMatchObject({ status: "failure", reason: expect.stringMatching(/timed out/u) });
  });
});

describe("provider endpoint validation (AR-12)", () => {
  it("accepts only Neon hosts with required TLS and no redirecting options", () => {
    expect(validatePostgresEndpoint("postgres://u:p@ep-cool-1.us-east-2.aws.neon.tech/db?sslmode=require", "neon")).toMatchObject({ ok: true });
    for (const hostile of [
      "postgres://u:p@attacker.example/db?sslmode=require",
      "postgres://u:p@neon.tech.attacker.example/db?sslmode=require",
      "postgres://u:p@ep-1.neon.tech/db",
      "postgres://u:p@ep-1.neon.tech/db?sslmode=disable",
      "postgres://u:p@ep-1.neon.tech/db?sslmode=require&host=attacker.example",
      "postgres://u:p@ep-1.neon.tech:6543/db?sslmode=require",
      "mysql://u:p@ep-1.neon.tech/db?sslmode=require",
      "not a url",
    ]) expect(validatePostgresEndpoint(hostile, "neon").ok, hostile).toBe(false);
  });

  it("accepts only provider API hosts over https without embedded credentials", () => {
    expect(validateApiEndpoint("https://api.resend.com/emails", "resend")).toMatchObject({ ok: true });
    for (const hostile of ["http://api.resend.com", "https://api.resend.com.evil.example", "https://user:key@api.resend.com", "https://api.resend.com:8443"]) expect(validateApiEndpoint(hostile, "resend").ok, hostile).toBe(false);
  });
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-infra-cli-"));
  directories.push(root);
  await mkdir(path.join(root, ".trestle"));
  await writeFile(path.join(root, ".trestle", "project.yaml"), "schemaVersion: 1\nproject:\n  name: fixture\napps: {}\npackages: {}\ntenancy:\n  model: organization\n  enforcement: postgres-rls\ndatabase:\n  engine: postgresql\n  defaultProvider: neon\ncapabilities:\n  r2: false\n  queues: false\n  workflows: false\n  durableObjects: false\n  admin: false\nenvironments: [local, staging]\n");
  return root;
}

function runtimeFor(root: string, environment: Record<string, string>) {
  const output = { stdout: "", stderr: "" };
  return {
    output,
    runtime: { cwd: () => root, stdout: (text: string) => { output.stdout += text; }, stderr: (text: string) => { output.stderr += text; }, environment: (name: string) => environment[name], infra: { now: () => new Date("2026-10-02T00:00:00.000Z") } },
  };
}

const INTENT = "schemaVersion: 1\nbackend: stripe-projects\nenvironments:\n  staging:\n    projectsBinding: staging-infra\n    resources:\n      database:\n        provider: neon\n        service: postgres\n        plan: free\n        credentialBindings:\n          bootstrap: {output: DATABASE_URL, classification: operator-only}\n";

describe("trestle infra read-only commands", () => {
  it("is experimental", async () => {
    const root = await project();
    const { runtime, output } = runtimeFor(root, fake.environment());
    expect(await executeCli(["infra", "catalog"], runtime)).not.toBe(0);
    expect(output.stderr).toMatch(/experimental/u);
  });

  it("initializes local configuration only and refuses to overwrite", async () => {
    const root = await project();
    const { runtime, output } = runtimeFor(root, fake.environment());
    expect(await executeCli(["infra", "init", "--backend", "stripe-projects", "--experimental"], runtime)).toBe(0);
    expect(output.stdout).toMatch(/No remote resources were created/u);
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toContain(".trestle/infrastructure.local/");
    expect(await executeCli(["infra", "init", "--backend", "stripe-projects", "--experimental"], runtime)).not.toBe(0);
    expect(await fake.calls()).toEqual([]);
  });

  it("plans, inspects status and runs doctor with zero mutating provider calls (AR-09)", async () => {
    const root = await project();
    const { runtime, output } = runtimeFor(root, fake.environment());
    await executeCli(["infra", "init", "--backend", "stripe-projects", "--experimental"], runtime);
    await writeFile(path.join(root, ".trestle", "infrastructure.yaml"), INTENT);
    output.stdout = "";
    expect(await executeCli(["infra", "plan", "--env", "staging", "--json", "--experimental"], runtime)).toBe(0);
    const planned = JSON.parse(output.stdout) as { data: { plan: { stale: boolean; digest: string }; executable: boolean; file: string } };
    expect(planned.data).toMatchObject({ executable: false, plan: { stale: true } });
    const planFile = path.join(root, planned.data.file);
    expect((await stat(planFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(planFile, "utf8")).not.toMatch(/postgres:\/\/|sk_live/u);
    output.stdout = "";
    expect(await executeCli(["infra", "status", "--env", "staging", "--experimental"], runtime)).toBe(0);
    expect(output.stdout).toMatch(/unknown, not empty/u);
    output.stdout = "";
    expect(await executeCli(["infra", "doctor", "--env", "staging", "--json", "--experimental"], runtime)).not.toBe(0);
    const doctor = JSON.parse(output.stdout) as { data: { checks: Array<{ id: string; status: string }> } };
    expect(doctor.data.checks.find((check) => check.id === "binding")).toMatchObject({ status: "fail" });
    expect(doctor.data.checks.find((check) => check.id === "active-verification")).toMatchObject({ status: "unknown" });
    expect(doctor.data.checks.some((check) => check.status === "pass" && check.id === "projects-status")).toBe(false);
    output.stdout = "";
    expect(await executeCli(["infra", "catalog", "neon", "--live", "--experimental"], runtime)).toBe(0);
    expect(mutatingCalls(await fake.calls())).toEqual([]);
    expect(await readdir(root)).not.toContain(".projects");
  });

  it("reports mutation commands as unavailable and never invokes the provider", async () => {
    const root = await project();
    const { runtime, output } = runtimeFor(root, fake.environment());
    for (const argv of [["rotate", "database-bootstrap"], ["destroy", "database"], ["link", "neon"], ["credentials", "pull"]]) {
      output.stderr = "";
      expect(await executeCli(["infra", ...argv, "--env", "staging", "--experimental"], runtime), argv.join(" ")).not.toBe(0);
      expect(output.stderr).toMatch(/not available yet|blocked|no reviewed Projects binding|infrastructure\.yaml/u);
    }
    expect(mutatingCalls(await fake.calls())).toEqual([]);
  });

  it("rejects local as an infrastructure environment and prints only allowlisted dashboards", async () => {
    const root = await project();
    const { runtime, output } = runtimeFor(root, fake.environment());
    expect(await executeCli(["infra", "plan", "--env", "local", "--experimental"], runtime)).not.toBe(0);
    expect(await executeCli(["infra", "open", "neon", "--experimental"], runtime)).toBe(0);
    expect(output.stdout.trim()).toBe("https://console.neon.tech/app/projects");
    expect(await executeCli(["infra", "open", "https://evil.example", "--experimental"], runtime)).not.toBe(0);
  });

  it("runs as a real CLI process from the built package", async () => {
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
    const root = await project();
    const { stdout } = await promisify(execFile)(process.execPath, [bin, "infra", "catalog", "neon", "--json", "--experimental"], { cwd: root, env: { ...fake.environment(), PATH: "/usr/bin:/bin" } });
    const parsed = JSON.parse(stdout) as { data: { toolchain: { qualified: boolean }; capabilities: Array<{ operation: string; allowed: boolean }> } };
    expect(parsed.data.toolchain.qualified).toBe(false);
    expect(parsed.data.capabilities.filter((row) => row.allowed).map((row) => row.operation)).toEqual([]);
  });
});

describe("trestle doctor integration", () => {
  it("validates infrastructure configuration without claiming remote readiness", async () => {
    const { runDoctor } = await import("../src/doctor.js");
    const { loadProjectManifest } = await import("../src/core.js");
    const root = await project();
    const without = await runDoctor(root, await loadProjectManifest(root), "local");
    expect(without.checks.some((check) => check.id === "infra.intent.valid")).toBe(false);
    await writeFile(path.join(root, ".trestle", "infrastructure.yaml"), INTENT);
    const valid = await runDoctor(root, await loadProjectManifest(root), "local");
    expect(valid.checks.find((check) => check.id === "infra.intent.valid")).toMatchObject({ status: "pass", message: expect.stringMatching(/remote readiness is not checked/u) });
    await writeFile(path.join(root, ".trestle", "infrastructure.yaml"), `${INTENT}        apiKey: sk_live_ABCDEFGH12345678\n`);
    const invalid = await runDoctor(root, await loadProjectManifest(root), "local");
    expect(invalid.checks.find((check) => check.id === "infra.intent.valid")).toMatchObject({ status: "fail" });
    expect(JSON.stringify(invalid)).not.toContain("sk_live_ABCDEFGH12345678");
  });
});
