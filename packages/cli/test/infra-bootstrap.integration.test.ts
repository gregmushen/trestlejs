import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyBootstrap, planBootstrap, PROJECT_BOOTSTRAP_CAPABILITY } from "../src/infra/bootstrap.js";
import { approvalFor, generateApproverKeys, signApproval } from "../src/infra/approvals.js";
import { StripeProjectsAdapter, verifyToolchain } from "../src/infra/adapters/stripe-projects.js";
import { SUPPORTED_TOOLCHAIN } from "../src/infra/capabilities.js";
import { nodeProcessRunner } from "../src/infra/process.js";
import { PostgresOperationStore } from "../src/infra/stores/postgres.js";
import { createFakeProjects } from "./helpers/fake-projects.js";

const url = process.env.TRESTLE_INFRA_CONTROL_TEST_DATABASE_URL;
describe.skipIf(!url)("project bootstrap with PostgreSQL and a separate fake provider process", () => {
  it("does not create twice when a separate connection acquires its reservation after the winner commits", async () => {
    const fake = await createFakeProjects();
    const firstWorkspace = await mkdtemp(`${tmpdir()}/trestle-bootstrap-first-`);
    const secondWorkspace = await mkdtemp(`${tmpdir()}/trestle-bootstrap-second-`);
    const schema = `b_${randomBytes(6).toString("hex")}`;
    const firstStore = await PostgresOperationStore.connect(url!, { schema });
    const secondStore = await PostgresOperationStore.connect(url!, { schema });
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { reached = resolve; });
    try {
      const location = { stripePath: fake.stripePath, pluginRoot: fake.pluginRoot, home: fake.home };
      const check = await verifyToolchain(location, nodeProcessRunner, { ...SUPPORTED_TOOLCHAIN, pluginSha256: fake.pluginSha256 });
      if (!check.ok) throw new Error("fake toolchain rejected");
      const adapter = new StripeProjectsAdapter(check.toolchain, location, nodeProcessRunner);
      // Fake provider only; never qualify native init from this subprocess fixture.
      const capability = { ...PROJECT_BOOTSTRAP_CAPABILITY, toolchain: check.toolchain, evidence: "hosted_verified" as const, unknowns: [] };
      const now = () => new Date("2026-10-16T12:00:00Z");
      const intent = { schemaVersion: 1, backend: "stripe-projects", environments: { staging: { projectsBinding: "fixture", resources: {} } } } as const;
      const keys = generateApproverKeys();
      await firstStore.registerApprover("reviewer", keys.publicKeyPem, ["staging"], now());
      const input = (id: string, name: string) => {
        const plan = planBootstrap({ intent, environment: "staging", applicationId: "fixture", stripeAccountId: "acct_fake0000001", name, toolchain: check.toolchain, now: now(), capability });
        return { plan, approval: signApproval(approvalFor(plan, { operationId: id, approverId: "reviewer", now: now() }), keys.privateKeyPem), intent };
      };
      const deps = (store: PostgresOperationStore, workspace: string) => ({ store, workspace, adapter, toolchain: check.toolchain, now, simulation: true, capability });
      const reserve = secondStore.reserve.bind(secondStore);
      secondStore.reserve = async (...args) => { reached(); await paused; return reserve(...args); };
      const late = applyBootstrap(input("op-late", "late-project"), deps(secondStore, secondWorkspace));
      await arrived;
      try { expect((await applyBootstrap(input("op-winner", "winner-project"), deps(firstStore, firstWorkspace))).outcome).toBe("succeeded"); }
      finally { release(); }
      await expect(late).resolves.toMatchObject({ outcome: "blocked" });
      const remote = await fake.remote();
      expect(remote.effects.init).toBe(1);
      expect(Object.keys(remote.projects)).toHaveLength(1);
      expect((await secondStore.readGeneration("bindings:fixture:staging"))?.data.bootstrapOperation).toBe("op-winner");
      expect(await secondStore.getReservation("projects-bootstrap:fixture:staging")).toBeUndefined();
    } finally {
      release();
      await firstStore.close(); await secondStore.close();
      const db = postgres(url!, { max: 1, onnotice: () => {} });
      try { await db.unsafe(`drop schema if exists ${schema} cascade`); } finally { await db.end(); }
      await rm(firstWorkspace, { recursive: true, force: true });
      await rm(secondWorkspace, { recursive: true, force: true });
      await fake.cleanup();
    }
  });

  it("recovers a crash after create across store reconnection without another provider effect", async () => {
    const fake = await createFakeProjects();
    const workspace = await mkdtemp(`${tmpdir()}/trestle-bootstrap-pg-`);
    const schema = `b_${randomBytes(6).toString("hex")}`;
    let store = await PostgresOperationStore.connect(url!, { schema });
    let tick = Date.parse("2026-10-16T12:00:00Z");
    const now = () => new Date(tick);
    try {
      const location = { stripePath: fake.stripePath, pluginRoot: fake.pluginRoot, home: fake.home };
      const check = await verifyToolchain(location, nodeProcessRunner, { ...SUPPORTED_TOOLCHAIN, pluginSha256: fake.pluginSha256 });
      if (!check.ok) throw new Error("fake toolchain rejected");
      const adapter = new StripeProjectsAdapter(check.toolchain, location, nodeProcessRunner);
      // Fake provider only; never qualify native init from this subprocess fixture.
      const capability = { ...PROJECT_BOOTSTRAP_CAPABILITY, toolchain: check.toolchain, evidence: "hosted_verified" as const, unknowns: [] };
      const intent = { schemaVersion: 1, backend: "stripe-projects", environments: { staging: { projectsBinding: "fixture", resources: {} } } } as const;
      const plan = planBootstrap({ intent, environment: "staging", applicationId: "fixture", stripeAccountId: "acct_fake0000001", name: "fixture-project", toolchain: check.toolchain, now: now(), capability });
      const keys = generateApproverKeys();
      await store.registerApprover("reviewer", keys.publicKeyPem, ["staging"], now());
      const approval = signApproval(approvalFor(plan, { operationId: "op-bootstrap-crash", approverId: "reviewer", now: now() }), keys.privateKeyPem);
      const deps = () => ({ store, adapter, workspace, toolchain: check.toolchain, now, simulation: true, capability });
      const append = store.appendEvent.bind(store);
      store.appendEvent = async (id, kind, data, at) => {
        if (kind === "infra.bootstrap.created") throw new Error("simulated process loss after remote creation");
        return append(id, kind, data, at);
      };
      await expect(applyBootstrap({ plan, approval, intent }, deps())).rejects.toThrow("simulated process loss");
      expect((await fake.remote()).effects.init).toBe(1);
      await store.close();
      store = await PostgresOperationStore.connect(url!, { schema });
      tick += 600_001;
      expect((await applyBootstrap({ plan, approval, intent }, deps())).outcome).toBe("succeeded");
      expect((await applyBootstrap({ plan, approval, intent }, deps())).outcome).toBe("succeeded");
      expect((await fake.remote()).effects.init).toBe(1);
      const binding = (await store.readGeneration("bindings:fixture:staging"))?.data.binding;
      expect(binding).toMatchObject({ projectsProjectId: Object.keys((await fake.remote()).projects)[0], stripeAccountId: "acct_fake0000001", generation: 1 });
      const journal = JSON.stringify(await store.exportState());
      expect(journal).not.toMatch(/postgres:\/\/|privateKeyPem|BEGIN PRIVATE/);
    } finally {
      await store.close();
      const db = postgres(url!, { max: 1, onnotice: () => {} });
      try { await db.unsafe(`drop schema if exists ${schema} cascade`); } finally { await db.end(); }
      await rm(workspace, { recursive: true, force: true });
      await fake.cleanup();
    }
  });
});
