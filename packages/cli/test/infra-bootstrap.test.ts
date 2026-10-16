import { afterEach, expect, it, vi } from "vitest";
import { applyBootstrap, inspectBootstrap, planBootstrap, PROJECT_BOOTSTRAP_CAPABILITY } from "../src/infra/bootstrap.js";
import { approvalFor, generateApproverKeys, signApproval } from "../src/infra/approvals.js";
import { SUPPORTED_TOOLCHAIN } from "../src/infra/capabilities.js";
import { MemoryOperationStore } from "../src/infra/stores/memory.js";

const clock = () => new Date("2026-10-16T12:00:00Z");
const intent = { schemaVersion: 1, backend: "stripe-projects", environments: { production: { projectsBinding: "lohu-production", resources: {} } } } as const;
const keys = generateApproverKeys();
// Fake-provider proof only: real native init remains blocked.
const capability = { ...PROJECT_BOOTSTRAP_CAPABILITY, evidence: "hosted_verified" as const, unknowns: [], observedAt: clock().toISOString() };
const directories: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(`${tmpdir()}/trestle-bootstrap-`); directories.push(root);
  const store = new MemoryOperationStore();
  await store.registerApprover("greg", keys.publicKeyPem, ["production"], clock());
  const plan = planBootstrap({ intent, environment: "production", applicationId: "lohu", stripeAccountId: "acct_example123", name: "lohu-production", toolchain: SUPPORTED_TOOLCHAIN, now: clock(), capability });
  const approval = signApproval(approvalFor(plan, { operationId: "op-bootstrap", approverId: "greg", now: clock() }), keys.privateKeyPem);
  let initialized = false;
  const mutate = vi.fn(async () => { initialized = true; return { status: "ok", data: {} } as const; });
  const observe = vi.fn(async () => initialized ? { status: "ok", observation: { observedAt: clock().toISOString(), stripeAccountId: "acct_example123", projectsProjectId: "project_actual123", projectsEnvironment: "default", complete: true, resources: [] } } as const : { status: "unknown", reason: "not initialized" } as const);
  return { root, store, plan, approval, mutate, observe, deps: { store, adapter: { mutate, observe }, workspace: root, now: clock, simulation: true, capability, toolchain: SUPPORTED_TOOLCHAIN } };
}

it("observes an expired bootstrap despite the closed create gate without changing durable state", async () => {
  const h = await fixture();
  h.mutate.mockResolvedValueOnce({ status: "unknown", reason: "lost response" } as never);
  await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps);
  const before = await h.store.exportState();
  h.observe.mockResolvedValue({ status: "ok", observation: { observedAt: clock().toISOString(), stripeAccountId: "acct_example123", projectsProjectId: "project_recovered", projectsEnvironment: "default", complete: true, resources: [] } });
  const answer = await inspectBootstrap({ plan: h.plan, operationId: "op-bootstrap" }, { store: h.store, workspace: h.root, adapter: { observe: h.observe }, now: () => new Date("2026-10-18T12:00:00Z") });
  expect(answer).toMatchObject({ status: "observed", observationOnly: true, projectId: "project_recovered" });
  expect(await h.store.exportState()).toEqual(before);
  expect(h.mutate).toHaveBeenCalledTimes(1);
});

it("leaves a missing bootstrap workspace unresolved and fenced, with sanitized diagnostics", async () => {
  const h = await fixture();
  h.mutate.mockResolvedValueOnce({ status: "unknown", reason: "lost response" } as never);
  await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps);
  const before = await h.store.exportState();
  h.observe.mockResolvedValue({ status: "unknown", reason: "NO_PROJECT_CONFIG https://auth.example/?token=hidden password=opaque123" } as never);
  const answer = await inspectBootstrap({ plan: h.plan, operationId: "op-bootstrap" }, { store: h.store, workspace: h.root, adapter: { observe: h.observe }, now: clock });
  expect(answer).toMatchObject({ status: "unresolved", observationOnly: true });
  expect(JSON.stringify(answer)).not.toMatch(/auth\.example|opaque123/);
  expect(await h.store.exportState()).toEqual(before);
});

it("refuses bootstrap inspection with another plan, operation, or workspace before calling the provider", async () => {
  const h = await fixture();
  h.mutate.mockResolvedValueOnce({ status: "unknown", reason: "lost response" } as never);
  await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps);
  h.observe.mockClear();
  const deps = { store: h.store, workspace: h.root, adapter: { observe: h.observe }, now: clock };
  expect((await inspectBootstrap({ plan: { ...h.plan, bootstrap: { ...h.plan.bootstrap, name: "tampered" } }, operationId: "op-bootstrap" }, deps)).status).toBe("blocked");
  expect((await inspectBootstrap({ plan: h.plan, operationId: "op-other" }, deps)).status).toBe("blocked");
  expect((await inspectBootstrap({ plan: h.plan, operationId: "op-bootstrap" }, { ...deps, workspace: `${h.root}/other` })).status).toBe("blocked");
  expect(h.observe).not.toHaveBeenCalled();
});

it("does not accept a different account or a conflicting create receipt as recovered identity", async () => {
  const h = await fixture();
  h.mutate.mockResolvedValueOnce({ status: "unknown", reason: "lost response" } as never);
  await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps);
  const deps = { store: h.store, workspace: h.root, adapter: { observe: h.observe }, now: clock };
  h.observe.mockResolvedValue({ status: "ok", observation: { observedAt: clock().toISOString(), stripeAccountId: "acct_other123", projectsProjectId: "project_recovered", projectsEnvironment: "default", complete: true, resources: [] } });
  expect((await inspectBootstrap({ plan: h.plan, operationId: "op-bootstrap" }, deps)).status).toBe("blocked");
  await h.store.appendEvent("op-bootstrap", "infra.bootstrap.created", { projectId: "project_original" }, clock());
  h.observe.mockResolvedValue({ status: "ok", observation: { observedAt: clock().toISOString(), stripeAccountId: "acct_example123", projectsProjectId: "project_recovered", projectsEnvironment: "default", complete: true, resources: [] } });
  expect((await inspectBootstrap({ plan: h.plan, operationId: "op-bootstrap" }, deps)).status).toBe("blocked");
  expect(await h.store.readGeneration("bindings:lohu:production")).toBeUndefined();
});

it("plans project creation without inventing an existing project identity or making provider calls", () => {
  const plan = planBootstrap({ intent, environment: "production", applicationId: "lohu", stripeAccountId: "acct_example123", name: "lohu-production", toolchain: SUPPORTED_TOOLCHAIN, now: clock() });
  expect(plan.target?.projectsProjectId).toMatch(/^pending:/);
  expect(plan.operations[0]?.effects).toContain("remote_project_create");
  expect(plan.bootstrap).toMatchObject({ name: "lohu-production", applicationId: "lohu" });
  expect(plan.operations[0]?.capability.allowed).toBe(false);
  expect(plan.blockers.join(" ")).toMatch(/native.*retr|idempotency/i);
});

it("journals bounded sanitized unknown outcomes and observation failures without resending", async () => {
  const h = await fixture();
  h.mutate.mockRejectedValueOnce(new Error("native failure https://auth.example/authorize?code=private-code sk_live_ACCIDENTAL123456789\n" + "x".repeat(1000)));
  h.observe.mockResolvedValue({ status: "unknown", reason: "lookup https://auth.example/?token=hidden napi_abcdefghijklmnop1234" } as never);
  expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps)).outcome).toBe("outcome_unknown");
  const events = await h.store.events("op-bootstrap");
  expect(events.find(e => e.kind === "infra.bootstrap.result")?.data).toMatchObject({ status: "unknown" });
  const reason = events.find(e => e.kind === "infra.bootstrap.result")?.data.reason;
  expect(typeof reason).toBe("string");
  expect(String(reason).length).toBeLessThanOrEqual(300);
  expect(events.find(e => e.kind === "infra.bootstrap.observation_unavailable")?.data.reason).toMatch(/lookup/);
  expect(JSON.stringify(events)).not.toMatch(/private-code|sk_live_|napi_|auth\.example|token=hidden/);
  expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps)).outcome).toBe("outcome_unknown");
  expect(h.mutate).toHaveBeenCalledTimes(1);
});

it("rejects credential-shaped application IDs without echoing them into a plan or diagnostic", () => {
  const secret = "sk_live_ACCIDENTAL123456789";
  try {
    planBootstrap({ intent, environment: "production", applicationId: secret, stripeAccountId: "acct_example123", name: "lohu-production", toolchain: SUPPORTED_TOOLCHAIN, now: clock(), capability });
    throw new Error("credential was accepted");
  } catch (error) {
    expect(String(error)).toMatch(/must not contain credential/);
    expect(String(error)).not.toContain(secret);
  }
});

it("journals before create, binds the observed exact identity, and never creates again on approval replay", async () => {
  const h = await fixture();
  h.mutate.mockImplementationOnce(async () => {
    expect((await h.store.events("op-bootstrap")).at(-1)?.kind).toBe("infra.bootstrap.intent");
    // A separate observed identity is authoritative, not a name or the create payload.
    h.observe.mockResolvedValue({ status: "ok", observation: { observedAt: clock().toISOString(), stripeAccountId: "acct_example123", projectsProjectId: "project_actual123", projectsEnvironment: "default", complete: true, resources: [] } });
    return { status: "ok", data: {} };
  });
  const result = await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps);
  expect(result.outcome).toBe("succeeded");
  expect((await h.store.readGeneration("bindings:lohu:production"))?.data.binding).toMatchObject({ projectsProjectId: "project_actual123", projectsEnvironment: "default" });
  expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps)).outcome).toBe("succeeded");
  expect(h.mutate).toHaveBeenCalledTimes(1);
});

it("requires durable state, signed authority, unchanged intent and pinned toolchain before creating", async () => {
  const h = await fixture();
  expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, { ...h.deps, simulation: false })).outcome).toBe("blocked");
  expect((await applyBootstrap({ plan: h.plan, approval: { ...h.approval, signature: "forged" }, intent }, h.deps)).outcome).toBe("blocked");
  expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent: { ...intent, environments: {} } }, h.deps)).outcome).toBe("blocked");
  expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, { ...h.deps, toolchain: { ...SUPPORTED_TOOLCHAIN, pluginVersion: "99.0.0" } })).outcome).toBe("blocked");
  expect(h.mutate).not.toHaveBeenCalled();
});

it("refuses nonempty private workspaces rather than initializing over unrelated files", async () => {
  const h = await fixture();
  const { writeFile, readFile } = await import("node:fs/promises");
  await writeFile(`${h.root}/unrelated.txt`, "preserve me");
  expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps)).outcome).toBe("blocked");
  expect(h.mutate).not.toHaveBeenCalled();
  expect(await readFile(`${h.root}/unrelated.txt`, "utf8")).toBe("preserve me");
});

it("does not retry an ambiguous create or accept another operation while the target is uncertain", async () => {
  const h = await fixture();
  h.mutate.mockResolvedValueOnce({ status: "unknown", reason: "lost response" } as never);
  expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps)).outcome).toBe("outcome_unknown");
  expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps)).outcome).toBe("outcome_unknown");
  const second = signApproval(approvalFor(h.plan, { operationId: "op-second", approverId: "greg", now: clock() }), keys.privateKeyPem);
  expect((await applyBootstrap({ plan: h.plan, approval: second, intent }, h.deps)).outcome).not.toBe("succeeded");
  expect(h.mutate).toHaveBeenCalledTimes(1);
});

it("refuses account drift after create and retains recovery state instead of binding the wrong account", async () => {
  const h = await fixture();
  h.mutate.mockImplementationOnce(async () => {
    h.observe.mockResolvedValue({ status: "ok", observation: { observedAt: clock().toISOString(), stripeAccountId: "acct_wrong123", projectsProjectId: "project_wrong", projectsEnvironment: "default", complete: true, resources: [] } });
    return { status: "ok", data: {} };
  });
  expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps)).outcome).toBe("needs_intervention");
  expect(await h.store.readGeneration("bindings:lohu:production")).toBeUndefined();
});

it("serializes initialization of one application even when two plans choose different names", async () => {
  const h = await fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  h.mutate.mockImplementationOnce(async () => { await pending; return { status: "ok", data: {} }; });
  const first = applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps);
  await vi.waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(1));
  const other = planBootstrap({ intent, environment: "production", applicationId: "lohu", stripeAccountId: "acct_example123", name: "another-name", toolchain: SUPPORTED_TOOLCHAIN, now: clock(), capability });
  const approval = signApproval(approvalFor(other, { operationId: "op-other-name", approverId: "greg", now: clock() }), keys.privateKeyPem);
  let second;
  try { second = await applyBootstrap({ plan: other, approval, intent }, h.deps); } finally { release(); await first; }
  expect(second.outcome).toBe("failed_retryable");
  expect(h.mutate).toHaveBeenCalledTimes(1);
});

it("recovers an observed project after response loss without issuing init again", async () => {
  const h = await fixture();
  h.mutate.mockImplementationOnce(async () => {
    h.observe.mockResolvedValue({ status: "ok", observation: { observedAt: clock().toISOString(), stripeAccountId: "acct_example123", projectsProjectId: "project_recovered", projectsEnvironment: "default", complete: true, resources: [] } });
    return { status: "unknown", reason: "response lost" } as never;
  });
  expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps)).outcome).toBe("succeeded");
  expect(h.mutate).toHaveBeenCalledTimes(1);
});

it("rechecks the binding after a delayed reservation in a separate workspace", async () => {
  const h = await fixture();
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const otherRoot = await mkdtemp(`${tmpdir()}/trestle-bootstrap-late-`); directories.push(otherRoot);
  const otherPlan = planBootstrap({ intent, environment: "production", applicationId: "lohu", stripeAccountId: "acct_example123", name: "another-name", toolchain: SUPPORTED_TOOLCHAIN, now: clock(), capability });
  const otherApproval = signApproval(approvalFor(otherPlan, { operationId: "op-delayed", approverId: "greg", now: clock() }), keys.privateKeyPem);
  let release!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { reached = resolve; });
  const reserve = h.store.reserve.bind(h.store);
  vi.spyOn(h.store, "reserve").mockImplementation(async (...args) => {
    if (args[1] === "op-delayed") { reached(); await paused; }
    return reserve(...args);
  });
  const late = applyBootstrap({ plan: otherPlan, approval: otherApproval, intent }, { ...h.deps, workspace: otherRoot });
  await arrived;
  try { expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps)).outcome).toBe("succeeded"); }
  finally { release(); }
  await expect(late).resolves.toMatchObject({ outcome: "blocked" });
  expect(h.mutate).toHaveBeenCalledTimes(1);
  expect((await h.store.readGeneration("bindings:lohu:production"))?.data.bootstrapOperation).toBe("op-bootstrap");
  expect(await h.store.getReservation("projects-bootstrap:lohu:production")).toBeUndefined();
});

it("never retries a definitive rejection and rechecks revocation even after success", async () => {
  const h = await fixture();
  h.mutate.mockResolvedValueOnce({ status: "rejected", code: "DENIED", message: "denied" } as never);
  expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps)).outcome).toBe("failed_terminal");
  expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps)).outcome).toBe("failed_terminal");
  expect(h.mutate).toHaveBeenCalledTimes(1);
  await h.store.revokeApprover("greg", clock());
  expect((await applyBootstrap({ plan: h.plan, approval: h.approval, intent }, h.deps)).outcome).toBe("blocked");
});
