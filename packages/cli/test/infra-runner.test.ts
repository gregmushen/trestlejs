import { readdir } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { readCommittedSnapshot } from "../src/infra/credentials.js";
import { applyPlan, bindingScope, type Boundary } from "../src/infra/runner.js";
import { MemoryOperationStore } from "../src/infra/stores/memory.js";
import { createHarness, type Harness } from "./helpers/infra-harness.js";

let harness: Harness;
afterEach(async () => { await harness?.cleanup(); });

class SimulatedCrash extends Error {}

const SECRETS = /postgres:\/\/owner_|re_fake|_secret@/u;

async function boundIds(h: Harness): Promise<Record<string, string>> {
  const committed = await h.store.readGeneration(bindingScope("trestle-proj-1", "staging"));
  const resources = (committed?.data.binding as { resources?: Record<string, { externalId: string }> } | undefined)?.resources ?? {};
  return Object.fromEntries(Object.entries(resources).map(([name, resource]) => [name, resource.externalId]));
}

async function liveResources(h: Harness) {
  const remote = await h.fake.remote();
  return Object.values(remote.projects).flatMap((project) => project.environments.staging?.resources ?? []).filter((resource) => !resource.deleted);
}

async function assertConverged(h: Harness) {
  const remote = await h.fake.remote();
  expect(remote.effects.add).toBe(2);
  expect(remote.effects.remove).toBeUndefined();
  const live = await liveResources(h);
  expect(live.map((resource) => resource.name).sort()).toEqual(["database", "email"]);
  const ids = await boundIds(h);
  expect(ids).toEqual(Object.fromEntries(live.map((resource) => [resource.name, resource.id])));
  const operator = await readCommittedSnapshot(h.store, { projectId: "trestle-proj-1", environment: "staging", purpose: "operator" }, h.masterKey);
  expect(Object.keys(operator.values)).toEqual(["DATABASE_URL"]);
  expect(operator.values.DATABASE_URL).toContain(ids.database!.replace(/_/gu, "-"));
  const deployment = await readCommittedSnapshot(h.store, { projectId: "trestle-proj-1", environment: "staging", purpose: "deployment" }, h.masterKey);
  expect(Object.keys(deployment.values)).toEqual(["RESEND_API_KEY"]);
  expect((await readdir(h.workspace)).filter((file) => file.startsWith(".env"))).toEqual([]);
  expect(JSON.stringify(await h.store.exportState())).not.toMatch(SECRETS);
}

describe("infrastructure executor", () => {
  it("creates, binds and imports credentials in dependency order without leaving plaintext", async () => {
    harness = await createHarness();
    const plan = await harness.plan();
    expect(plan.operations.map((operation) => [operation.resource, operation.classification])).toEqual([["database", "create"], ["email", "create"]]);
    const result = await applyPlan({ plan, approval: harness.approve(plan), intent: harness.intent, bindings: harness.bindings }, harness.deps());
    expect(result).toMatchObject({ outcome: "succeeded", completed: ["database", "email"] });
    await assertConverged(harness);
    const kinds = (await harness.store.events("op-apply-1")).map((event) => event.kind);
    expect(kinds.indexOf("infra.effect.intent")).toBeLessThan(kinds.indexOf("infra.resource.created"));
    expect(kinds.at(-1)).toBe("infra.apply.completed");
  });

  it("treats replay of the same approval as resume with no second side effect (AR-01)", async () => {
    harness = await createHarness();
    const plan = await harness.plan();
    const approval = harness.approve(plan);
    await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps());
    const replay = await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps({ holder: "other-runner" }));
    expect(replay.outcome).toBe("succeeded");
    await assertConverged(harness);
    const reuse = await applyPlan({ plan, approval: { ...approval, payload: { ...approval.payload, operationId: "op-apply-2" } }, intent: harness.intent, bindings: harness.bindings }, harness.deps());
    expect(reuse.outcome).toBe("blocked");
    expect((await harness.fake.remote()).effects.add).toBe(2);
  });

  it("rejects altered plans, uncovered effects, memory stores outside simulation, and unregistered approvers", async () => {
    harness = await createHarness();
    const plan = await harness.plan();
    const approval = harness.approve(plan);
    const run = (overrides: Parameters<typeof applyPlan>[0], deps = harness.deps()) => applyPlan(overrides, deps);
    expect(await run({ plan: { ...plan, operations: plan.operations.slice(1) }, approval, intent: harness.intent, bindings: harness.bindings })).toMatchObject({ outcome: "blocked", nextStep: expect.stringMatching(/altered/u) });
    const narrow = harness.approve(plan, "op-narrow", { allowedEffects: ["remote_read"] });
    expect(await run({ plan, approval: narrow, intent: harness.intent, bindings: harness.bindings })).toMatchObject({ outcome: "blocked", nextStep: expect.stringMatching(/effects not covered/u) });
    expect(await run({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps({ simulation: false }))).toMatchObject({ outcome: "blocked", nextStep: expect.stringMatching(/independent PostgreSQL/u) });
    const forged = { ...approval, payload: { ...approval.payload, approverId: "mallory" } };
    expect(await run({ plan, approval: forged, intent: harness.intent, bindings: harness.bindings })).toMatchObject({ outcome: "blocked" });
    expect((await harness.fake.remote()).effects.add).toBeUndefined();
  });

  it("refuses account drift and material change since planning", async () => {
    harness = await createHarness();
    const plan = await harness.plan();
    const wrongAccount = { ...harness.bindings, environments: { staging: { ...harness.bindings.environments.staging!, stripeAccountId: "acct_other000001" } } };
    expect(await applyPlan({ plan, approval: harness.approve(plan), intent: harness.intent, bindings: wrongAccount }, harness.deps())).toMatchObject({ outcome: "blocked" });
    const changed = structuredClone(harness.intent);
    changed.environments.staging!.resources.email!.dependsOn = [];
    expect(await applyPlan({ plan, approval: harness.approve(plan), intent: changed, bindings: harness.bindings }, harness.deps())).toMatchObject({ outcome: "blocked", nextStep: expect.stringMatching(/intent changed since planning/u) });
    expect((await harness.fake.remote()).effects.add).toBeUndefined();
  });

  const boundaries: Boundary[] = ["before_intent", "after_intent", "after_begin", "after_effect", "after_created_event", "after_binding_commit", "after_snapshot_commit", "after_cleanup", "after_release"];
  for (const resource of ["database", "email"]) {
    for (const boundary of boundaries) {
      it(`recovers from runner termination at ${boundary} of ${resource} without duplicate effects`, async () => {
        harness = await createHarness();
        const plan = await harness.plan();
        const approval = harness.approve(plan);
        let crashed = false;
        const hooks = { at: (at: Boundary, context: { resource: string }) => { if (!crashed && at === boundary && context.resource === resource) { crashed = true; throw new SimulatedCrash(at); } } };
        await expect(applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps({ hooks, holder: "runner-a" }))).rejects.toThrow(SimulatedCrash);
        // A replacement runner starts after runner-a's lease has lapsed.
        harness.clock.advance(120_000);
        const confirmAbsent = boundary === "after_begin" ? { actor: "operator", reason: "runner-a process confirmed dead before its request was sent" } : undefined;
        const resumed = await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps({ holder: "runner-b", ...(confirmAbsent ? { confirmAbsent } : {}) }));
        expect(resumed.outcome, JSON.stringify(resumed)).toBe("succeeded");
        await assertConverged(harness);
      });
    }
  }

  it("keeps a lost response unknown, then binds the resource found by observation instead of recreating it", async () => {
    harness = await createHarness();
    await harness.fake.setBehavior({ faults: [{ command: "add", stage: "after", kind: "lose-response" }] });
    const plan = await harness.plan();
    const approval = harness.approve(plan);
    const first = await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps({ holder: "runner-a" }));
    expect(first).toMatchObject({ outcome: "outcome_unknown", unresolved: ["database", "email"] });
    expect((await harness.fake.remote()).effects.add).toBe(1);
    expect((await harness.store.getOperation("op-apply-1"))?.state).toBe("outcome_unknown");
    const second = await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps({ holder: "runner-b" }));
    expect(second.outcome).toBe("succeeded");
    expect(second.messages.join(" ")).toMatch(/reconciled earlier uncertain create/u);
    await assertConverged(harness);
  });

  it("does not retry when an uncertain create is absent but cannot be proven dead (AR-02)", async () => {
    harness = await createHarness();
    const plan = await harness.plan();
    const approval = harness.approve(plan);
    let crashed = false;
    await expect(applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps({ holder: "runner-a", hooks: { at: (at) => { if (!crashed && at === "after_begin") { crashed = true; throw new SimulatedCrash(at); } } } }))).rejects.toThrow(SimulatedCrash);
    // Before the lease lapses the target is busy.
    expect(await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps({ holder: "runner-b" }))).toMatchObject({ outcome: "failed_retryable" });
    harness.clock.advance(120_000);
    const unknown = await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps({ holder: "runner-b" }));
    expect(unknown).toMatchObject({ outcome: "outcome_unknown", nextStep: expect.stringMatching(/--confirm-absent/u) });
    expect((await harness.fake.remote()).effects.add).toBeUndefined();
  });

  it("stays unknown when discovery is incomplete after a lost response", async () => {
    harness = await createHarness();
    await harness.fake.setBehavior({ faults: [{ command: "add", stage: "after", kind: "lose-response" }] });
    const plan = await harness.plan();
    const approval = harness.approve(plan);
    await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps());
    await harness.fake.setBehavior({ incompleteStatus: true });
    const again = await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps({ holder: "runner-b" }));
    expect(again.outcome).not.toBe("succeeded");
    expect((await harness.fake.remote()).effects.add).toBe(1);
  });

  it("retries a provider rejection that proves no effect, with backoff on the injected clock", async () => {
    harness = await createHarness();
    await harness.fake.setBehavior({ faults: [{ command: "add", stage: "before", kind: "error", code: "PROVIDER_UNAVAILABLE", times: 2 }] });
    const plan = await harness.plan();
    const started = Date.now();
    const result = await applyPlan({ plan, approval: harness.approve(plan), intent: harness.intent, bindings: harness.bindings }, harness.deps());
    expect(result.outcome).toBe("succeeded");
    expect(harness.clock.sleeps).toEqual([1000, 2000]);
    expect(Date.now() - started).toBeLessThan(20_000);
    await assertConverged(harness);
  });

  it("stops on a terminal rejection and never deletes what earlier steps created (AR-13)", async () => {
    harness = await createHarness();
    await harness.fake.setBehavior({ faults: [{ command: "add", stage: "before", kind: "error", code: "TERMS_NOT_ACCEPTED" }] });
    // The fault fires on the first add (database); swap order by faulting the second add instead.
    await harness.fake.setBehavior({ faults: [{ command: "add", stage: "before", kind: "error", code: "TERMS_NOT_ACCEPTED", times: 1 }] });
    const plan = await harness.plan();
    const approval = harness.approve(plan);
    const first = await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps());
    expect(first).toMatchObject({ outcome: "needs_intervention", unresolved: ["database", "email"] });
    expect((await harness.fake.remote()).effects.add).toBeUndefined();
    const second = await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps());
    expect(second.outcome).toBe("succeeded");
    await assertConverged(harness);
  });

  it("retains an earlier resource when a later step fails terminally", async () => {
    harness = await createHarness();
    const plan = await harness.plan();
    const approval = harness.approve(plan);
    let calls = 0;
    const adapter = { observe: harness.adapter.observe.bind(harness.adapter), mutate: async (...args: Parameters<typeof harness.adapter.mutate>) => {
      if (args[0] === "add" && ++calls === 2) return { status: "rejected" as const, code: "QUOTA_EXCEEDED", message: "quota" };
      return harness.adapter.mutate(...args);
    } };
    const result = await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps({ adapter }));
    expect(result).toMatchObject({ outcome: "needs_intervention", completed: ["database"], unresolved: ["email"] });
    expect((await liveResources(harness)).map((resource) => resource.name)).toEqual(["database"]);
    expect((await harness.fake.remote()).effects.remove).toBeUndefined();
  });

  it("rejects a plan made from a stale binding generation (old checkout)", async () => {
    harness = await createHarness();
    const plan = await harness.plan();
    await harness.store.commitGeneration(bindingScope("trestle-proj-1", "staging"), 0, "sha256:x", { binding: { ...harness.bindings.environments.staging!, generation: 2, resources: { database: { provider: "neon", service: "postgres", externalId: "neon_other", lifecycleOwner: "stripe-projects", boundBy: "op-elsewhere" } } } });
    expect(await applyPlan({ plan, approval: harness.approve(plan), intent: harness.intent, bindings: harness.bindings }, harness.deps())).toMatchObject({ outcome: "blocked", nextStep: expect.stringMatching(/stale binding generation/u) });
    expect((await harness.fake.remote()).effects.add).toBeUndefined();
  });

  it("refuses renewal-free resume once the approval expired, without repeating committed effects", async () => {
    harness = await createHarness();
    await harness.fake.setBehavior({ faults: [{ command: "add", stage: "after", kind: "lose-response" }] });
    const plan = await harness.plan();
    const approval = harness.approve(plan);
    await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps());
    harness.clock.advance(2 * 3600_000);
    expect(await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps())).toMatchObject({ outcome: "blocked", nextStep: expect.stringMatching(/expired/u) });
    expect((await harness.fake.remote()).effects.add).toBe(1);
    void MemoryOperationStore;
  });
});

describe("lease loss during a successful create", () => {
  it("reports intervention instead of crashing when another runner marked the target uncertain", async () => {
    harness = await createHarness();
    const plan = await harness.plan();
    const approval = harness.approve(plan);
    const hooks = { at: async (at: Boundary, context: { resource: string }) => {
      if (at === "after_effect" && context.resource === "database") {
        harness.clock.advance(120_000);
        expect(await harness.store.reserve("projects:acct_fake0000001:" + harness.bindings.environments.staging!.projectsProjectId + ":staging", "op-other", "runner-b", 60_000, harness.clock.now())).toMatchObject({ status: "uncertain" });
      }
    } };
    const result = await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps({ hooks }));
    expect(result).toMatchObject({ outcome: "needs_intervention", unresolved: ["database", "email"] });
    expect((await harness.fake.remote()).effects.add).toBe(1);
    expect((await boundIds(harness)).database).toBeDefined();
  });
});

describe("authority on resume", () => {
  it("refuses to resume after the approver is revoked, leaving committed effects alone", async () => {
    harness = await createHarness();
    await harness.fake.setBehavior({ faults: [{ command: "add", stage: "after", kind: "lose-response" }] });
    const plan = await harness.plan();
    const approval = harness.approve(plan);
    expect((await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps())).outcome).toBe("outcome_unknown");
    await harness.store.revokeApprover("alice", harness.clock.now());
    const resumed = await applyPlan({ plan, approval, intent: harness.intent, bindings: harness.bindings }, harness.deps({ holder: "runner-b" }));
    expect(resumed).toMatchObject({ outcome: "blocked", nextStep: expect.stringMatching(/revoked/u) });
    expect((await harness.fake.remote()).effects.add).toBe(1);
  });
});

describe("last-moment duplicate guard (Projects add is not idempotent)", () => {
  async function racingAdapter(h: Harness) {
    let observations = 0;
    return {
      mutate: h.adapter.mutate.bind(h.adapter),
      observe: async (workspace: string, now: Date) => {
        // After the precondition observation, another writer creates the same name.
        if (++observations === 2) await h.adapter.mutate("add", ["neon/postgres"], { name: "database" }, workspace, ["remote_link", "remote_resource_create", "remote_secret_store_write", "local_state_write", "local_vault_write", "local_plaintext_credentials", "may_charge"]);
        return h.adapter.observe(workspace, now);
      },
    };
  }

  it("refuses to create when the name appeared since planning, with no effect journaled", async () => {
    harness = await createHarness();
    const plan = await harness.plan();
    const result = await applyPlan({ plan, approval: harness.approve(plan), intent: harness.intent, bindings: harness.bindings }, harness.deps({ adapter: await racingAdapter(harness) }));
    expect(result).toMatchObject({ outcome: "needs_intervention", nextStep: expect.stringMatching(/--allow-duplicate/u) });
    expect((await harness.fake.remote()).effects.add).toBe(1);
    expect((await harness.store.events("op-apply-1")).some((event) => event.kind === "infra.effect.intent")).toBe(false);
    expect(await harness.store.getReservation(`projects:acct_fake0000001:${harness.bindings.environments.staging!.projectsProjectId}:staging`)).toBeUndefined();
  });

  it("proceeds under an explicit, journaled override", async () => {
    harness = await createHarness();
    const plan = await harness.plan();
    const result = await applyPlan({ plan, approval: harness.approve(plan), intent: harness.intent, bindings: harness.bindings }, harness.deps({ adapter: await racingAdapter(harness), allowDuplicate: { actor: "greg", reason: "second database intended" } }));
    expect(result.outcome).toBe("succeeded");
    const allowed = (await harness.store.events("op-apply-1")).find((event) => event.kind === "infra.duplicate.allowed");
    expect(allowed?.data).toMatchObject({ resource: "database", actor: "greg", reason: "second database intended" });
  });
});
