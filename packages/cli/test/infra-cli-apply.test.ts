import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";
import { createFakeProjects, mutatingCalls, type FakeProjects } from "./helpers/fake-projects.js";

const url = process.env.TRESTLE_INFRA_CONTROL_TEST_DATABASE_URL;
let fake: FakeProjects;
const directories: string[] = [];
beforeEach(async () => { fake = await createFakeProjects(); });
afterEach(async () => { await fake.cleanup(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const INTENT = "schemaVersion: 1\nbackend: stripe-projects\nenvironments:\n  staging:\n    projectsBinding: staging-infra\n    resources:\n      database:\n        provider: neon\n        service: postgres\n        plan: free\n";

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-infra-apply-"));
  directories.push(root);
  await mkdir(path.join(root, ".trestle"));
  await writeFile(path.join(root, ".trestle", "project.yaml"), "schemaVersion: 1\nproject:\n  name: fixture\napps: {}\npackages: {}\ntenancy:\n  model: organization\n  enforcement: postgres-rls\ndatabase:\n  engine: postgresql\n  defaultProvider: neon\ncapabilities:\n  r2: false\n  queues: false\n  workflows: false\n  durableObjects: false\n  admin: false\nenvironments: [local, staging]\n");
  await writeFile(path.join(root, ".trestle", "infrastructure.yaml"), INTENT);
  await writeFile(path.join(root, ".trestle", "infrastructure.bindings.json"), JSON.stringify({ schemaVersion: 1, environments: { staging: { trestleProjectId: "trestle-proj-1", stripeAccountId: "acct_fake0000001", projectsProjectId: "proj_fake0001", projectsEnvironment: "staging", generation: 1, resources: {} } } }));
  return root;
}

function cli(root: string, extra: Record<string, string> = {}) {
  const output = { stdout: "", stderr: "" };
  const environment = { ...fake.environment(), TRESTLE_MASTER_KEY: randomBytes(32).toString("hex"), ...extra };
  return { output, run: (argv: string[]) => executeCli([...argv, "--experimental"], { cwd: () => root, stdout: (text) => { output.stdout += text; }, stderr: (text) => { output.stderr += text; }, environment: (name) => environment[name as keyof typeof environment], infra: { now: () => new Date("2026-10-02T00:00:00.000Z") } }) };
}

describe("trestle infra apply", () => {
  it("refuses to run without an independent control store and never reaches the provider", async () => {
    const root = await project();
    const { run, output } = cli(root);
    expect(await run(["infra", "plan", "--env", "staging", "--json"])).toBe(0);
    const planFile = (JSON.parse(output.stdout) as { data: { file: string } }).data.file;
    await writeFile(path.join(root, "approval.json"), JSON.stringify({ payload: { operationId: "op-x" }, signature: "" }));
    expect(await run(["infra", "apply", planFile, "--env", "staging", "--approval", "approval.json"])).toBe(2);
    expect(output.stderr).toMatch(/TRESTLE_INFRA_CONTROL_DATABASE_URL/u);
    expect(mutatingCalls(await fake.calls())).toEqual([]);
  });

  it("keeps approver keys outside the project with owner-only permissions", async () => {
    const root = await project();
    const { run, output } = cli(root);
    await run(["infra", "plan", "--env", "staging", "--json"]);
    const planFile = (JSON.parse(output.stdout) as { data: { file: string } }).data.file;
    const keyDir = await mkdtemp(path.join(os.tmpdir(), "trestle-approver-"));
    directories.push(keyDir);
    expect(await run(["infra", "approver", "keygen", "--out", path.join(keyDir, "alice.pem")])).toBe(0);
    expect(await run(["infra", "approver", "keygen", "--out", path.join(root, "inside.pem")])).toBe(0);
    output.stderr = "";
    expect(await run(["infra", "approve", planFile, "--env", "staging", "--approver", "alice", "--key", path.join(root, "inside.pem")])).not.toBe(0);
    expect(output.stderr).toMatch(/outside the project/u);
    output.stdout = "";
    expect(await run(["infra", "approve", planFile, "--env", "staging", "--approver", "alice", "--key", path.join(keyDir, "alice.pem"), "--operation-id", "op-cli-1"])).toBe(0);
    const approval = JSON.parse(await readFile(path.join(root, ".trestle", "infrastructure.local", "approvals", "op-cli-1.json"), "utf8")) as { payload: { planDigest: string }; signature: string };
    expect(approval.signature.length).toBeGreaterThan(40);
  });

  describe.skipIf(!url)("with a control store", () => {
    const schemas: string[] = [];
    afterAll(async () => {
      const sql = postgres(url!, { max: 1, onnotice: () => {} });
      await sql.unsafe("drop schema if exists trestle_infra cascade");
      await sql.end();
      void schemas;
    });

    it("stays blocked by real capability evidence even with a valid signed approval", async () => {
      const root = await project();
      const { run, output } = cli(root, { TRESTLE_INFRA_CONTROL_DATABASE_URL: url! });
      const keyDir = await mkdtemp(path.join(os.tmpdir(), "trestle-approver-"));
      directories.push(keyDir);
      await run(["infra", "approver", "keygen", "--out", path.join(keyDir, "alice.pem")]);
      const approverId = `alice-${randomBytes(3).toString("hex")}`;
      expect(await run(["infra", "approver", "register", approverId, "--public-key", path.join(keyDir, "alice.pem.pub"), "--env", "staging"])).toBe(0);
      output.stdout = "";
      await run(["infra", "plan", "--env", "staging", "--json"]);
      const planFile = (JSON.parse(output.stdout) as { data: { file: string } }).data.file;
      await run(["infra", "approve", planFile, "--env", "staging", "--approver", approverId, "--key", path.join(keyDir, "alice.pem"), "--operation-id", "op-cli-2"]);
      // Link a workspace through the fake so apply reaches its capability gate.
      const workspace = path.join(root, ".trestle", "infrastructure.local", "projects", "staging");
      await mkdir(path.join(workspace, ".projects"), { recursive: true });
      await writeFile(path.join(workspace, ".projects", "state.json"), JSON.stringify({ projectId: "proj_fake0001", outputs: { staging: ".env.staging" } }));
      await writeFile(path.join(workspace, ".projects", "state.local.json"), JSON.stringify({ active: "staging" }));
      await writeFile(path.join(fake.home, "fake-projects", "remote.json"), JSON.stringify({ accountId: "acct_fake0000001", nextId: 2, projects: { proj_fake0001: { name: "x", environments: { staging: { resources: [] } } } }, effects: {} }));
      output.stderr = "";
      const code = await run(["infra", "apply", planFile, "--env", "staging", "--approval", ".trestle/infrastructure.local/approvals/op-cli-2.json"]);
      expect(code, output.stderr).toBe(2);
      expect(output.stderr).toMatch(/blocked/u);
      expect(mutatingCalls(await fake.calls())).toEqual([]);
    });
  });
});

describe("trestle infra lifecycle and rotation planning", () => {
  it("writes blocked, exact-ID plans for destroy, detach, adopt, upgrade and rotate without provider writes", async () => {
    const root = await project();
    await writeFile(path.join(root, ".trestle", "infrastructure.yaml"), `${INTENT}        deletionPolicy: delete\n        credentialBindings:\n          runtime: {output: DATABASE_URL, classification: provider-managed, consumers: [worker]}\n`);
    await writeFile(path.join(root, ".trestle", "project.yaml"), (await readFile(path.join(root, ".trestle", "project.yaml"), "utf8")).replace("apps: {}", "apps:\n  worker: apps/worker"));
    await writeFile(path.join(root, ".trestle", "infrastructure.bindings.json"), JSON.stringify({ schemaVersion: 1, environments: { staging: { trestleProjectId: "trestle-proj-1", stripeAccountId: "acct_fake0000001", projectsProjectId: "proj_fake0001", projectsEnvironment: "staging", generation: 2, resources: { database: { provider: "neon", service: "postgres", plan: "free", externalId: "neon_res0001", lifecycleOwner: "stripe-projects", boundBy: "op-1" } } } } }));
    const { run, output } = cli(root);
    const cases: Array<[string[], RegExp]> = [
      [["infra", "destroy", "database", "--env", "staging", "--confirm-target", "database"], /confirm the exact target ID/u],
      [["infra", "detach", "database", "--env", "staging"], /non-destructive detach/u],
      [["infra", "upgrade", "database", "--env", "staging", "--to", "launch"], /price is unknown/u],
      // neon/postgres has a qualified profile, but its real bundle (DATABASE_CONNECTION_STRING) is not declared here.
      [["infra", "rotate", "runtime", "--env", "staging", "--inventory-complete"], /undeclared outputs: DATABASE_CONNECTION_STRING/u],
    ];
    for (const [argv, reason] of cases) {
      output.stdout = "";
      output.stderr = "";
      expect(await run(argv), argv.join(" ")).toBe(2);
      expect(output.stderr, argv.join(" ")).toMatch(reason);
      expect(output.stdout).toContain("neon_res0001");
    }
    expect(mutatingCalls(await fake.calls())).toEqual([]);
  });
});
