import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { applyPages, planPages, readPagesArtifact, registerPagesHost, type PagesHost } from "../src/infra/pages.js";
import { pagesWranglerDigest, stagingRunMatches, WranglerPagesHost } from "../src/infra/pages-host.js";
import { buildPagesFunctions } from "../src/infra/pages-build.js";
import { approvalFor, generateApproverKeys, signApproval } from "../src/infra/approvals.js";
import { MemoryOperationStore } from "../src/infra/stores/memory.js";
import type { ProcessSpec } from "../src/infra/process.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const now = () => new Date("2026-10-16T12:00:00Z");
const intent = { schemaVersion: 1, backend: "stripe-projects", environments: { production: { projectsBinding: "fixture", resources: {} } } } as const;
const binding = { trestleProjectId: "fixture", stripeAccountId: "acct_example123", projectsProjectId: "project_example123", projectsEnvironment: "default", generation: 1, resources: {} };
const commit = "a".repeat(40);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "trestle-pages-test-")); roots.push(root);
  await mkdir(path.join(root, "dist")); await mkdir(path.join(root, "functions"));
  await writeFile(path.join(root, "dist/index.html"), "<h1>reviewed</h1>");
  await writeFile(path.join(root, "dist/_worker.js"), "export default { fetch: () => new Response('compiled') };");
  await writeFile(path.join(root, "functions/index.js"), "export const onRequest = () => new Response('ok');");
  await writeFile(path.join(root, "wrangler.pages.jsonc"), JSON.stringify({ name: "fixture-pages", pages_build_output_dir: "./dist", compatibility_date: "2026-10-16", services: [{ binding: "TRESTLE_API", service: "fixture-worker" }] }));
  const artifact = await readPagesArtifact(root);
  const args = { intent, binding, environment: "production" as const, app: "apps/app", accountId: "b".repeat(32), artifact, commit, repository: "example/fixture", wranglerSha256: "c".repeat(64), now: now() };
  const plan = planPages({ ...args, fakeHost: true });
  const store = new MemoryOperationStore();
  const keys = generateApproverKeys();
  await store.registerApprover("reviewer", keys.publicKeyPem, ["production"], now());
  await registerPagesHost({ store, applicationId: binding.trestleProjectId, environment: "production", app: "apps/app", accountId: args.accountId, project: artifact.project, services: artifact.services, actor: "control-admin" });
  const approval = signApproval(approvalFor(plan, { operationId: "op-pages", approverId: "reviewer", artifactDigest: artifact.digest, now: now() }), keys.privateKeyPem);
  let marker: { operationId: string; artifactDigest: string } | null = null;
  const host: PagesHost = { preflight: vi.fn(async () => {}), upload: vi.fn(async (directory) => { marker = JSON.parse(await readFile(path.join(directory, "dist/.well-known/trestle-release.json"), "utf8")); }), marker: vi.fn(async () => marker) };
  return { root, artifact, args, plan, store, keys, approval, host, input: { plan, approval, intent, binding, artifact }, deps: { store, host, now, simulation: true } };
}

it("snapshots config, assets and Functions and keeps real deployment unqualified", async () => {
  const h = await fixture();
  expect(h.artifact.files.map(file => file.name)).toEqual(["wrangler.pages.jsonc", "dist/_worker.js", "dist/index.html", "functions/index.js"]);
  expect(planPages(h.args).blockers.join(" ")).toMatch(/hosted qualification/);
  expect((await applyPages(h.input, { ...h.deps, simulation: false })).outcome).toBe("blocked");
  expect(h.host.upload).not.toHaveBeenCalled();
});

it("uploads immutable reviewed bytes under signed authority, records intent first and verifies the exact operation", async () => {
  const h = await fixture();
  await writeFile(path.join(h.root, "dist/index.html"), "unapproved later edit");
  h.host.upload = vi.fn(async (directory) => {
    expect((await h.store.events("op-pages")).at(-1)?.kind).toBe("infra.pages.intent");
    expect(await readFile(path.join(directory, "dist/index.html"), "utf8")).toBe("<h1>reviewed</h1>");
    expect(JSON.parse(await readFile(path.join(directory, "wrangler.jsonc"), "utf8")).services).toEqual([{ binding: "TRESTLE_API", service: "fixture-worker" }]);
    h.host.marker = async () => ({ operationId: "op-pages", artifactDigest: h.artifact.digest });
  });
  expect((await applyPages(h.input, h.deps)).outcome).toBe("succeeded");
  expect((await applyPages(h.input, h.deps)).outcome).toBe("succeeded");
  expect(h.host.upload).toHaveBeenCalledTimes(1);
});

it("never resends an uncertain upload or counts an old marker as verification", async () => {
  const h = await fixture();
  h.host.upload = vi.fn(async () => { throw new Error("lost response"); });
  h.host.marker = async () => ({ operationId: "op-old", artifactDigest: h.artifact.digest });
  expect((await applyPages(h.input, h.deps)).outcome).toBe("outcome_unknown");
  expect((await applyPages(h.input, h.deps)).outcome).toBe("outcome_unknown");
  h.host.marker = async () => ({ operationId: "op-pages", artifactDigest: h.artifact.digest });
  expect((await applyPages(h.input, h.deps)).outcome).toBe("succeeded");
  expect(h.host.upload).toHaveBeenCalledTimes(1);
});

it("journals sanitized upload failures while preserving the no-resend fence", async () => {
  const h = await fixture();
  h.host.upload = vi.fn(async () => { throw new Error("lost https://auth.example/?code=private-code sk_live_ACCIDENTAL123456789"); });
  expect((await applyPages(h.input, h.deps)).outcome).toBe("outcome_unknown");
  const events = await h.store.events("op-pages");
  expect(events.find(e => e.kind === "infra.pages.result")?.data).toMatchObject({ status: "unknown", reason: expect.stringContaining("lost") });
  expect(JSON.stringify(events)).not.toMatch(/auth\.example|private-code|sk_live_/);
  expect((await applyPages(h.input, h.deps)).outcome).toBe("outcome_unknown");
  expect(h.host.upload).toHaveBeenCalledTimes(1);
});

it("rejects forged approval, changed binding/artifact and a failed promotion preflight before upload", async () => {
  const h = await fixture();
  expect((await applyPages({ ...h.input, approval: { ...h.approval, signature: "forged" } }, h.deps)).outcome).toBe("blocked");
  expect((await applyPages({ ...h.input, binding: { ...binding, generation: 2 } }, h.deps)).outcome).toBe("blocked");
  await writeFile(path.join(h.root, "dist/index.html"), "changed");
  expect((await applyPages({ ...h.input, artifact: await readPagesArtifact(h.root) }, h.deps)).outcome).toBe("blocked");
  h.host.preflight = async () => { throw new Error("no staging success"); };
  expect((await applyPages(h.input, h.deps)).outcome).toBe("blocked");
  expect(h.host.upload).not.toHaveBeenCalled();
});

it("rejects symlinks, credential files and arbitrary Wrangler build hooks", async () => {
  const h = await fixture();
  await symlink(path.join(h.root, "wrangler.pages.jsonc"), path.join(h.root, "dist/alias"));
  await expect(readPagesArtifact(h.root)).rejects.toThrow(/symlinks/);
  await rm(path.join(h.root, "dist/alias"));
  await writeFile(path.join(h.root, "dist/.env"), "secret");
  await expect(readPagesArtifact(h.root)).rejects.toThrow(/credential files/);
  await rm(path.join(h.root, "dist/.env"));
  const config = JSON.parse(await readFile(path.join(h.root, "wrangler.pages.jsonc"), "utf8"));
  await writeFile(path.join(h.root, "wrangler.pages.jsonc"), JSON.stringify({ ...config, build: { command: "untrusted hook" } }));
  await expect(readPagesArtifact(h.root)).rejects.toThrow();
});

it("requires exact successful staging workflow identity rather than any successful workflow", () => {
  const run = { head_sha: commit, event: "push", head_branch: "main", status: "completed", conclusion: "success", path: ".github/workflows/deploy.yml", repository: { full_name: "example/fixture" } };
  expect(stagingRunMatches(run, "example/fixture", commit)).toBe(true);
  for (const change of [{ head_sha: "b".repeat(40) }, { event: "pull_request" }, { status: "in_progress" }, { conclusion: "failure" }, { head_branch: "other" }, { path: ".github/workflows/ci.yml" }, { repository: { full_name: "other/repo" } }]) expect(stagingRunMatches({ ...run, ...change }, "example/fixture", commit)).toBe(false);
});

it("prevents cross-environment host enrollment and service-binding changes even with a new artifact approval", async () => {
  const h = await fixture();
  await expect(registerPagesHost({ store: h.store, applicationId: binding.trestleProjectId, environment: "staging", app: "apps/app", accountId: h.plan.pages.accountId, project: h.artifact.project, services: h.artifact.services, actor: "admin" })).rejects.toThrow(/another application or environment/);
  const configFile = path.join(h.root, "wrangler.pages.jsonc");
  const config = JSON.parse(await readFile(configFile, "utf8")); config.services[0].service = "other-environment-worker";
  await writeFile(configFile, JSON.stringify(config));
  const artifact = await readPagesArtifact(h.root);
  const plan = planPages({ ...h.args, artifact, fakeHost: true });
  const approval = signApproval(approvalFor(plan, { operationId: "op-retarget", approverId: "reviewer", artifactDigest: artifact.digest, now: now() }), h.keys.privateKeyPem);
  expect((await applyPages({ ...h.input, plan, approval, artifact }, h.deps)).outcome).toBe("blocked");
  expect(h.host.upload).not.toHaveBeenCalled();
});

it("rejects mutation of snapshot bytes after signing and requires precompiled Functions", async () => {
  const h = await fixture();
  h.artifact.files.find(file => file.name === "dist/index.html")!.bytes = Buffer.from("mutated after signing");
  expect((await applyPages(h.input, h.deps)).outcome).toBe("blocked");
  expect(h.host.upload).not.toHaveBeenCalled();
  await rm(path.join(h.root, "dist/_worker.js"));
  await expect(readPagesArtifact(h.root)).rejects.toThrow(/compile Pages Functions/);
});

it("compiles Functions with no provider credentials and preserves another task's config redirect", async () => {
  const h = await fixture();
  await rm(path.join(h.root, "dist/_worker.js"));
  const tool = path.join(h.root, "tool"); await mkdir(path.join(tool, "bin"), { recursive: true }); await mkdir(path.join(tool, "wrangler-dist"));
  const binary = path.join(tool, "bin/wrangler.js"); await writeFile(binary, "fixture executable"); await writeFile(path.join(tool, "wrangler-dist/cli.js"), "fixture implementation"); await writeFile(path.join(tool, "package.json"), JSON.stringify({ version: "4.135.0" }));
  const calls: ProcessSpec[] = [];
  const runner = { run: async (spec: ProcessSpec) => {
    calls.push(spec);
    const out = spec.args[spec.args.indexOf("--outdir") + 1]!;
    await mkdir(out, { recursive: true }); await writeFile(path.join(out, "index.js"), "compiled worker");
    return { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, truncated: false };
  } };
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "do-not-pass"); vi.stubEnv("GH_TOKEN", "do-not-pass");
  try { expect(await buildPagesFunctions(h.root, binary, runner)).toEqual({ built: true }); } finally { vi.unstubAllEnvs(); }
  expect(calls[0]?.env).not.toHaveProperty("CLOUDFLARE_API_TOKEN"); expect(calls[0]?.env).not.toHaveProperty("GH_TOKEN");
  expect(await readFile(path.join(h.root, "dist/_worker.js/index.js"), "utf8")).toBe("compiled worker");
  await rm(path.join(h.root, "dist/_worker.js"), { recursive: true });
  const redirect = path.join(h.root, ".wrangler/deploy/config.json"); await writeFile(redirect, "another task's redirect");
  await expect(buildPagesFunctions(h.root, binary, runner)).rejects.toThrow();
  expect(await readFile(redirect, "utf8")).toBe("another task's redirect");
});

it("the native host checks account, project, Git and staging through bounded commands with separated credentials", async () => {
  const h = await fixture();
  const tool = path.join(h.root, "tool"); await mkdir(path.join(tool, "bin"), { recursive: true }); await mkdir(path.join(tool, "wrangler-dist"));
  const binary = path.join(tool, "bin/wrangler.js"); await writeFile(binary, "fixture executable"); await writeFile(path.join(tool, "wrangler-dist/cli.js"), "fixture implementation"); await writeFile(path.join(tool, "package.json"), JSON.stringify({ version: "4.135.0" }));
  const calls: ProcessSpec[] = [];
  const runner = { run: async (spec: ProcessSpec) => {
    calls.push(spec);
    let output = "";
    if (spec.args.includes("rev-parse")) output = commit;
    else if (spec.args.includes("get-url")) output = "https://github.com/example/fixture.git";
    else if (spec.args.includes("whoami")) output = JSON.stringify({ accounts: [{ id: h.plan.pages.accountId }] });
    else if (spec.args.includes("project")) output = JSON.stringify([{ "Project Name": h.plan.pages.project }]);
    else if (spec.executable.endsWith("/gh")) output = JSON.stringify({ workflow_runs: [{ head_sha: commit, event: "push", head_branch: "main", status: "completed", conclusion: "success", path: ".github/workflows/deploy.yml", repository: { full_name: "example/fixture" } }] });
    return { stdout: output, stderr: "", exitCode: 0, signal: null, timedOut: false, truncated: false };
  } };
  const host = new WranglerPagesHost(h.root, binary, { HOME: h.root, GH_TOKEN: "github-secret", CLOUDFLARE_API_TOKEN: "cloudflare-secret" }, runner);
  await host.preflight({ ...h.plan, pages: { ...h.plan.pages, wranglerSha256: await pagesWranglerDigest(binary) } });
  expect(calls.every(call => call.maxOutputBytes <= 2_000_000 && call.timeoutMs <= 300_000)).toBe(true);
  expect(calls.filter(call => call.executable === process.execPath).every(call => !call.env.GH_TOKEN && call.env.CLOUDFLARE_API_TOKEN === "cloudflare-secret")).toBe(true);
  expect(calls.find(call => call.executable.endsWith("/gh"))?.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
});
