import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/infra/canonical.js";
import type { ConsumerId, ConsumerSpec } from "../src/infra/consumers.js";
import { commitSnapshot, readCommittedSnapshot } from "../src/infra/credentials.js";
import { deployCredentials, retiredGenerations, type ProbeResult } from "../src/infra/deployment.js";
import { applyPlan, bindingScope } from "../src/infra/runner.js";
import { planRotation, rotateCredential, rotationPlanDocument, type RetirementEvidence, type RotationProfile, type RotationProbes, type RotationState } from "../src/infra/rotation.js";
import type { EnvironmentBinding } from "../src/infra/schema.js";
import { createHarness, type Harness } from "./helpers/infra-harness.js";

let harness: Harness;
afterEach(async () => { await harness?.cleanup(); });

const IMMEDIATE: RotationProfile = { invalidation: "immediate", bundle: ["RESEND_API_KEY"], reRetrieval: "proven", retirementProbe: true };
const consumers: ConsumerSpec[] = [{ id: "worker", requiresNewConnection: true, plane: "application" }];
const expectedTargets = { worker: "fixture-worker-staging" };
const artifact = `sha256:${"cd".repeat(32)}`;
const DEPLOYMENT = { projectId: "trestle-proj-1", environment: "staging", purpose: "deployment" as const };

class Host implements RotationProbes {
  revision = 0;
  current: { revision: string; marker: string } | undefined;
  probeOverride?: (actual: { revision: string; marker: string }) => ProbeResult;
  drainedResult: boolean | "unknown" = true;
  retirement?: RetirementEvidence;
  control = true;
  constructor(private readonly fakeRemote: () => Promise<{ projects: Record<string, { environments: Record<string, { resources: Array<{ name: string; credentialVersion: number }> }> }> }>) {}
  async target() { return "fixture-worker-staging"; }
  async project(_consumer: ConsumerId, _target: string, _values: Record<string, string>, marker: string) { this.current = { revision: `rev-${++this.revision}`, marker }; return { revision: this.current.revision }; }
  async probe(): Promise<ProbeResult> { return this.probeOverride?.(this.current!) ?? { status: "ok", revision: this.current!.revision, credentialGeneration: this.current!.marker, newConnection: true }; }
  async drained() { return this.drainedResult; }
  async newCredentialAccepted() { return this.control; }
  /** Provider-specific probe against the fake: the old value is rejected once its version is superseded. */
  async oldCredentialRejected(_provider: string, oldValue: string): Promise<RetirementEvidence> {
    if (this.retirement) return this.retirement;
    const remote = await this.fakeRemote();
    const email = Object.values(remote.projects)[0]!.environments.staging!.resources.find((resource) => resource.name === "email")!;
    return oldValue.includes(`v${email.credentialVersion}ABCDEF`) ? "accepted" : "rejected";
  }
}

async function provisioned(): Promise<{ binding: EnvironmentBinding; host: Host }> {
  harness = await createHarness();
  const plan = await harness.plan();
  const result = await applyPlan({ plan, approval: harness.approve(plan, "op-provision"), intent: harness.intent, bindings: harness.bindings }, harness.deps());
  expect(result.outcome).toBe("succeeded");
  const binding = (await harness.store.readGeneration(bindingScope("trestle-proj-1", "staging")))!.data.binding as EnvironmentBinding;
  const host = new Host(() => harness.fake.remote());
  // Establish generation 1 on the consumer before rotating.
  await deployCredentials({ store: harness.store, scope: DEPLOYMENT, masterKey: harness.masterKey, consumers, expectedTargets, deployer: host, probes: host, artifactDigest: artifact, configDigest: "cfg", now: harness.clock.now });
  return { binding, host };
}

function rotation(binding: EnvironmentBinding, profile: RotationProfile | null = IMMEDIATE, inventoryComplete = true) {
  const unit = planRotation({ intent: harness.intent, environment: "staging", binding, credentialBinding: "sending", profile: profile ?? undefined, consumers, inventoryComplete });
  const plan = rotationPlanDocument(unit, { environment: "staging", binding, sourceDigest: canonicalDigest(harness.intent), toolchain: harness.toolchain, now: harness.clock.now() });
  return { unit, plan };
}

async function run(binding: EnvironmentBinding, host: Host, options: { profile?: RotationProfile | null; operationId?: string; hooks?: { at?: (state: RotationState) => void }; inventoryComplete?: boolean; approvalPlan?: ReturnType<typeof rotation>; confirmNotIssued?: { actor: string; reason: string } } = {}) {
  const prepared = options.approvalPlan ?? rotation(binding, options.profile === undefined ? IMMEDIATE : options.profile, options.inventoryComplete);
  const approval = harness.approve(prepared.plan, options.operationId ?? "op-rotate-1");
  return {
    prepared, approval,
    result: await rotateCredential({ rotation: prepared.unit, plan: prepared.plan, approval, intent: harness.intent, environment: "staging", projectId: "trestle-proj-1", scopeKey: "sending" }, {
      store: harness.store, adapter: harness.adapter, workspace: harness.workspace, projectRoot: harness.root, masterKey: harness.masterKey, now: harness.clock.now,
      deployer: host, probes: host, consumers, expectedTargets, artifactDigest: artifact, configDigest: "cfg", outputFile: path.join(harness.workspace, ".env.staging"), ...(options.hooks ? { hooks: options.hooks } : {}), ...(options.confirmNotIssued ? { confirmNotIssued: options.confirmNotIssued } : {}),
    }),
  };
}

const rotations = async () => (await harness.fake.remote()).effects.rotate ?? 0;

describe("rotation planning blocks unknown or unsafe strategies before issuance", () => {
  it("blocks unknown invalidation, unknown bundles, unrecoverable immediate keys, undeclared siblings, incomplete inventory and overlap without revoke", async () => {
    const { binding, host } = await provisioned();
    const cases: Array<[RotationProfile | null, boolean, RegExp]> = [
      [null, true, /invalidation behavior is unknown/u],
      [{ ...IMMEDIATE, bundle: null }, true, /rotation unit/u],
      [{ ...IMMEDIATE, reRetrieval: "unproven" }, true, /AR-03/u],
      [{ ...IMMEDIATE, bundle: ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"] }, true, /undeclared outputs: RESEND_WEBHOOK_SECRET/u],
      [IMMEDIATE, false, /consumer discovery is incomplete/u],
      [{ ...IMMEDIATE, invalidation: "overlap" }, true, /revoke operation/u],
      [{ ...IMMEDIATE, retirementProbe: false }, true, /prove old-key retirement/u],
    ];
    for (const [profile, inventory, reason] of cases) {
      const { result } = await run(binding, host, { profile, inventoryComplete: inventory, operationId: `op-${Math.random().toString(36).slice(2, 8)}` });
      expect(result.state).toBe("blocked");
      expect(result.detail).toMatch(reason);
    }
    expect(await rotations()).toBe(0);
  });
});

describe("rotation execution", () => {
  it("issues once, cuts over every consumer, proves retirement and retires the old generation", async () => {
    const { binding, host } = await provisioned();
    const before = await readCommittedSnapshot(harness.store, DEPLOYMENT, harness.masterKey);
    const { result } = await run(binding, host);
    expect(result).toMatchObject({ state: "completed", deployment: { verified: true } });
    expect(await rotations()).toBe(1);
    const after = await readCommittedSnapshot(harness.store, DEPLOYMENT, harness.masterKey);
    expect(after.generation).toBe(before.generation + 1);
    expect(after.values.RESEND_API_KEY).not.toBe(before.values.RESEND_API_KEY);
    expect((await retiredGenerations(harness.store, "trestle-proj-1", "staging")).retired).toEqual([before.generation]);
    expect(JSON.stringify(await harness.store.exportState())).not.toContain(before.values.RESEND_API_KEY);
    expect(JSON.stringify(await harness.store.exportState())).not.toContain(after.values.RESEND_API_KEY);
  });

  for (const crashAt of ["preflight_passed", "issuance_requested", "new_issued", "encrypted_snapshot_saved", "consumers_updated", "consumers_verified"] as RotationState[]) {
    it(`resumes after termination at ${crashAt} without a second issuance`, async () => {
      const { binding, host } = await provisioned();
      const prepared = rotation(binding);
      let crashed = false;
      await expect(run(binding, host, { approvalPlan: prepared, hooks: { at: (state) => { if (!crashed && state === crashAt) { crashed = true; throw new Error("killed"); } } } })).rejects.toThrow("killed");
      let resumed = await run(binding, host, { approvalPlan: prepared });
      if (crashAt === "issuance_requested") {
        // The crash came before the provider call, but the journal cannot prove that: no blind reissue.
        expect(resumed.result).toMatchObject({ state: "outcome_unknown", detail: expect.stringMatching(/--confirm-not-issued/u) });
        expect(await rotations()).toBe(0);
        resumed = await run(binding, host, { approvalPlan: prepared, confirmNotIssued: { actor: "operator", reason: "runner died before the request" } });
      }
      expect(resumed.result.state, resumed.result.detail).toBe("completed");
      expect(await rotations()).toBe(1);
    });
  }

  it("recovers a lost issuance response by re-retrieval, never by issuing again (AR-03)", async () => {
    const { binding, host } = await provisioned();
    await harness.fake.setBehavior({ faults: [{ command: "rotate", stage: "after", kind: "lose-response" }] });
    const prepared = rotation(binding);
    expect((await run(binding, host, { approvalPlan: prepared })).result.state).toBe("outcome_unknown");
    expect(await rotations()).toBe(1);
    expect((await run(binding, host, { approvalPlan: prepared })).result.state).toBe("completed");
    expect(await rotations()).toBe(1);
  });

  it("does not retire while one consumer still answers with the old generation (partial cutover)", async () => {
    const { binding, host } = await provisioned();
    host.probeOverride = (actual) => ({ status: "ok", revision: actual.revision, credentialGeneration: "staging:g1:cdcdcdcdcdcd", newConnection: true });
    const { result } = await run(binding, host);
    expect(result.state).toBe("partial_cutover");
    expect((await retiredGenerations(harness.store, "trestle-proj-1", "staging")).retired).toEqual([]);
  });

  it("does not retire while delayed jobs may still use the old generation (AR-08)", async () => {
    const { binding, host } = await provisioned();
    host.drainedResult = "unknown";
    expect((await run(binding, host)).result).toMatchObject({ state: "partial_cutover", detail: expect.stringMatching(/old generation \(unknown\)/u) });
  });

  it("reports retirement unknown on inconclusive probes or a failed new-key control (AR-07)", async () => {
    const { binding, host } = await provisioned();
    host.retirement = "inconclusive";
    expect((await run(binding, host)).result.state).toBe("cutover_verified_retirement_unknown");
    expect((await retiredGenerations(harness.store, "trestle-proj-1", "staging")).retired).toEqual([]);
  });

  it("treats a 401-style rejection without a working new-key control as inconclusive", async () => {
    const { binding, host } = await provisioned();
    host.control = false;
    host.retirement = "rejected";
    expect((await run(binding, host)).result.state).toBe("cutover_verified_retirement_unknown");
  });

  it("treats replay of a completed rotation approval as resume, with no second issuance", async () => {
    const { binding, host } = await provisioned();
    const prepared = rotation(binding);
    await run(binding, host, { approvalPlan: prepared });
    const replay = await run(binding, host, { approvalPlan: prepared });
    expect(replay.result.state).toBe("completed");
    expect(await rotations()).toBe(1);
  });

  it("stops on a provider rejection with the committed snapshot unchanged", async () => {
    const { binding, host } = await provisioned();
    await harness.fake.setBehavior({ faults: [{ command: "rotate", stage: "before", kind: "error", code: "ROTATION_NOT_SUPPORTED" }] });
    const before = await readCommittedSnapshot(harness.store, DEPLOYMENT, harness.masterKey);
    expect((await run(binding, host)).result.state).toBe("needs_intervention");
    expect((await readCommittedSnapshot(harness.store, DEPLOYMENT, harness.masterKey)).generation).toBe(before.generation);
  });

  it("prevents a stale pull and rollback from restoring the retired key (AR-04, AR-08, scenario 21)", async () => {
    const { binding, host } = await provisioned();
    const before = await readCommittedSnapshot(harness.store, DEPLOYMENT, harness.masterKey);
    await run(binding, host);
    await expect(commitSnapshot(harness.store, DEPLOYMENT, before.generation, before.values, before.metadata, harness.masterKey)).rejects.toThrow(/generation conflict/u);
    const retired = await retiredGenerations(harness.store, "trestle-proj-1", "staging");
    expect(retired.retired).toContain(before.generation);
    await expect(deployCredentials({ store: harness.store, scope: DEPLOYMENT, masterKey: harness.masterKey, consumers, expectedTargets, deployer: host, probes: host, artifactDigest: artifact, configDigest: "cfg", now: harness.clock.now, credentialGeneration: before.generation })).rejects.toThrow();
  });

  it("rejects an approval for a different rotation unit", async () => {
    const { binding, host } = await provisioned();
    const other = rotation(binding);
    const tampered = { ...other, unit: { ...other.unit, digest: "sha256:other" } };
    expect((await run(binding, host, { approvalPlan: tampered })).result.state).toBe("blocked");
    expect(await rotations()).toBe(0);
  });
});

describe("rotation unit narrower than the declared outputs (hosted finding 2026-10-02)", () => {
  it("requires only the rotating output to change, never the stable identifiers", async () => {
    const { binding } = await provisioned();
    const withIds = structuredClone(harness.intent);
    withIds.environments.staging!.resources.email!.credentialBindings["org"] = { output: "RESEND_ORG_ID", classification: "provider-managed", consumers: ["worker"] };
    const unit = planRotation({ intent: withIds, environment: "staging", binding, credentialBinding: "sending", profile: IMMEDIATE, consumers, inventoryComplete: true });
    expect(unit.rotates).toEqual(["RESEND_API_KEY"]);
    expect(unit.outputs).toEqual(["RESEND_API_KEY", "RESEND_ORG_ID"]);
    expect(unit.blockers).toEqual([]);
  });
});
