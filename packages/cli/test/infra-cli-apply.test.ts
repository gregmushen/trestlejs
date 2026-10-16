import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";
import { createFakeProjects, mutatingCalls, type FakeProjects } from "./helpers/fake-projects.js";
import { PostgresOperationStore } from "../src/infra/stores/postgres.js";
import { planBootstrap } from "../src/infra/bootstrap.js";
import { SUPPORTED_TOOLCHAIN } from "../src/infra/capabilities.js";
import { projectsWorkspace } from "../src/infra/doctor.js";

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

    it("inspects an expired blocked bootstrap through the CLI without altering its fence or invoking any mutation", async () => {
      const root = await project();
      const id = `op-bootstrap-inspect-${randomBytes(4).toString("hex")}`;
      const at = new Date("2026-10-01T00:00:00Z");
      const intent = { schemaVersion: 1, backend: "stripe-projects", environments: { staging: { projectsBinding: "staging-infra", resources: {} } } } as const;
      const plan = planBootstrap({ intent, environment: "staging", applicationId: id, stripeAccountId: "acct_fake0000001", name: "synthetic", toolchain: SUPPORTED_TOOLCHAIN, now: at });
      expect(plan.blockers.length).toBeGreaterThan(0);
      await writeFile(path.join(root, "bootstrap.json"), JSON.stringify(plan));
      const workspace = projectsWorkspace(root, "staging");
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      const store = await PostgresOperationStore.connect(url!);
      try {
        await store.createOperation({ id, environment: "staging", planDigest: plan.digest, approvalId: null, state: "outcome_unknown" }, at);
        await store.appendEvent(id, "infra.bootstrap.intent", { name: "synthetic", workspace, stripeAccountId: "acct_fake0000001" }, at);
        const scope = `projects-bootstrap:${id}:staging`;
        const reserved = await store.reserve(scope, id, "fixture", 600000, at);
        if (reserved.status !== "acquired") throw new Error("fixture reservation unavailable");
        await store.beginEffect(scope, reserved.reservation.fencingToken, `${id}:project-init`, at);
        await store.markUncertain(scope, reserved.reservation.fencingToken, at);
        const before = await store.exportState();
        const { run, output } = cli(root, { TRESTLE_INFRA_CONTROL_DATABASE_URL: url! });
        expect(await run(["infra", "project", "inspect", id, "--env", "staging", "--plan", "bootstrap.json"])).toBe(3);
        expect(JSON.parse(output.stdout).data).toMatchObject({ operationId: id, status: "unresolved", observationOnly: true });
        expect(await store.exportState()).toEqual(before);
        expect(mutatingCalls(await fake.calls())).toEqual([]);
        expect((await fake.calls()).some(call => call.args[1] === "status")).toBe(true);
      } finally { await store.close(); }
    });

    it("inspects the durable operation, events and uncertainty without requiring or trusting a local checkpoint", async () => {
      const root = await project();
      const id = `op-inspect-${randomBytes(4).toString("hex")}`;
      const store = await PostgresOperationStore.connect(url!);
      try {
        await store.createOperation({ id, environment: "staging", planDigest: `sha256:${"a".repeat(64)}`, approvalId: null, state: "outcome_unknown" }, new Date());
        await store.appendEvent(id, "infra.bootstrap.intent", { name: "synthetic", reason: "https://auth.example/?code=private-code sk_live_ACCIDENTAL123456789" }, new Date());
        const reserved = await store.reserve(`bootstrap:${id}`, id, "fixture", 600000, new Date());
        if (reserved.status !== "acquired") throw new Error("fixture reservation unavailable");
        await store.beginEffect(`bootstrap:${id}`, reserved.reservation.fencingToken, `${id}:init`, new Date());
        await store.markUncertain(`bootstrap:${id}`, reserved.reservation.fencingToken, new Date());
      } finally { await store.close(); }
      const { run, output } = cli(root, { TRESTLE_INFRA_CONTROL_DATABASE_URL: url! });
      expect(await run(["infra", "operation", "show", id])).toBe(0);
      const found = JSON.parse(output.stdout).data;
      expect(found.operation).toMatchObject({ id, state: "outcome_unknown" });
      expect(found.events[0]).toMatchObject({ kind: "infra.bootstrap.intent" });
      expect(found.reservations).toMatchObject([{ operationId: id, state: "uncertain", inflightEffect: `${id}:init` }]);
      expect(output.stdout).not.toMatch(/private-code|sk_live_|auth\.example/);
      const local = path.join(root, ".trestle/infrastructure.local/operations");
      await mkdir(local, { recursive: true });
      await writeFile(path.join(local, `${id}.json`), '{"state":"stale-local-succeeded"}');
      output.stdout = "";
      expect(await run(["infra", "operation", "show", id])).toBe(0);
      expect(output.stdout).not.toContain("stale-local-succeeded");
      output.stdout = "";
      expect(await run(["infra", "operation", "show", "op-missing-record"])).not.toBe(0);
      expect(output.stderr).toMatch(/no durable operation record/);
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
      await mkdir(path.join(workspace, ".projects"), { recursive: true, mode: 0o700 });
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
