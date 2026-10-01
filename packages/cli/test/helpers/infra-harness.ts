import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { stringify } from "yaml";

import { StripeProjectsAdapter, verifyToolchain, type VerifiedToolchain } from "../../src/infra/adapters/stripe-projects.js";
import { approvalFor, generateApproverKeys, signApproval, type SignedApproval } from "../../src/infra/approvals.js";
import { SUPPORTED_TOOLCHAIN, type CapabilityRow, type InfraOperation } from "../../src/infra/capabilities.js";
import { capabilityFor } from "../../src/infra/capability-matrix.js";
import { planInfrastructure, type InfraPlan } from "../../src/infra/planner.js";
import { nodeProcessRunner } from "../../src/infra/process.js";
import type { RunnerDeps } from "../../src/infra/runner.js";
import { parseBindings, parseIntent, type InfrastructureBindings, type InfrastructureIntent } from "../../src/infra/schema.js";
import type { OperationStore } from "../../src/infra/store.js";
import { MemoryOperationStore } from "../../src/infra/stores/memory.js";
import { createFakeProjects, type FakeProjects } from "./fake-projects.js";

/** A clock tests advance explicitly; sleeps advance it instead of waiting. */
export class TestClock {
  sleeps: number[] = [];
  constructor(private current = Date.parse("2026-10-02T00:00:00.000Z")) {}
  now = () => new Date(this.current);
  advance(ms: number): void { this.current += ms; }
  sleep = async (ms: number) => { this.sleeps.push(ms); this.current += ms; };
}

export const INTENT_YAML = stringify({
  schemaVersion: 1, backend: "stripe-projects",
  environments: {
    staging: {
      projectsBinding: "staging-infra",
      resources: {
        database: { provider: "neon", service: "postgres", plan: "free", credentialBindings: { bootstrap: { output: "DATABASE_URL", classification: "operator-only" } } },
        email: { provider: "resend", service: "email", plan: "free", dependsOn: ["database"], costLimit: { currency: "usd", monthlyMinor: 0 }, credentialBindings: { sending: { output: "RESEND_API_KEY", classification: "provider-managed", consumers: ["worker"] } } },
      },
    },
  },
});

export type Harness = {
  fake: FakeProjects;
  root: string;
  workspace: string;
  toolchain: VerifiedToolchain;
  adapter: StripeProjectsAdapter;
  store: OperationStore;
  clock: TestClock;
  intent: InfrastructureIntent;
  bindings: InfrastructureBindings;
  masterKey: string;
  approverKey: string;
  capabilities: (provider: string, service: string, operation: InfraOperation) => CapabilityRow | undefined;
  plan(intent?: InfrastructureIntent): Promise<InfraPlan>;
  approve(plan: InfraPlan, operationId?: string, overrides?: Partial<SignedApproval["payload"]>): SignedApproval;
  deps(overrides?: Partial<RunnerDeps>): RunnerDeps;
  cleanup(): Promise<void>;
};

/** Builds a fake-provider environment with an initialized, isolated Projects workspace. */
export async function createHarness(options: { store?: OperationStore } = {}): Promise<Harness> {
  const fake = await createFakeProjects();
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-runner-"));
  const workspace = path.join(root, ".trestle", "infrastructure.local", "projects", "staging");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const location = { stripePath: fake.stripePath, pluginRoot: fake.pluginRoot, home: fake.home };
  const check = await verifyToolchain(location, nodeProcessRunner, { ...SUPPORTED_TOOLCHAIN, pluginSha256: fake.pluginSha256 });
  if (!check.ok) throw new Error(check.reasons.join("; "));
  const adapter = new StripeProjectsAdapter(check.toolchain, location, nodeProcessRunner);
  const init = await adapter.mutate("init", [], { "skip-skills": true, "skip-install": true, mode: "manual" }, workspace, ["remote_project_create", "local_state_write", "local_gitignore_write", "local_agent_skills", "local_install_command"]);
  if (init.status !== "ok") throw new Error("fake init failed");
  await adapter.mutate("env create", ["staging"], { output: ".env.staging" }, workspace, ["remote_membership_change", "local_state_write"]);
  const projectId = (init.data as { project: { id: string } }).project.id;
  const bindings = parseBindings(JSON.stringify({ schemaVersion: 1, environments: { staging: { trestleProjectId: "trestle-proj-1", stripeAccountId: "acct_fake0000001", projectsProjectId: projectId, projectsEnvironment: "staging", generation: 1, resources: {} } } }));
  const store = options.store ?? new MemoryOperationStore();
  const clock = new TestClock();
  const keys = generateApproverKeys();
  await store.registerApprover("alice", keys.publicKeyPem, ["staging"], clock.now());
  const capabilities = (provider: string, service: string, operation: InfraOperation): CapabilityRow | undefined => {
    const row = capabilityFor(provider, service, operation);
    return row && row.evidence !== "unsupported" ? { ...row, evidence: "hosted_verified", unknowns: [], toolchain: check.toolchain, observedAt: clock.now().toISOString() } : row;
  };
  const intent = parseIntent(INTENT_YAML);
  const harness: Harness = {
    fake, root, workspace, toolchain: check.toolchain, adapter, store, clock, intent, bindings, masterKey: randomBytes(32).toString("hex"), approverKey: keys.privateKeyPem, capabilities,
    async plan(planIntent = intent) {
      const observed = await adapter.observe(workspace, clock.now());
      if (observed.status !== "ok") throw new Error(observed.reason);
      return planInfrastructure({ intent: planIntent, bindings, environment: "staging", observation: observed.observation, toolchain: check.toolchain, now: clock.now(), capabilities });
    },
    approve(plan, operationId = "op-apply-1", overrides = {}) {
      return signApproval({ ...approvalFor(plan, { operationId, approverId: "alice", now: clock.now() }), ...overrides }, keys.privateKeyPem);
    },
    deps(overrides = {}) {
      return { store, adapter, workspace, projectRoot: root, masterKey: harness.masterKey, now: clock.now, sleep: clock.sleep, simulation: true, capabilities, leaseMs: 60_000, ...overrides };
    },
    cleanup: async () => { await fake.cleanup(); await rm(root, { recursive: true, force: true }); },
  };
  return harness;
}
