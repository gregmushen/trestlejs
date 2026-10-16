import { expect, it, vi } from "vitest";
import { planProviderLink, applyProviderLink } from "../src/infra/provider-link.js";
import { capabilityFor } from "../src/infra/capability-matrix.js";
import { SUPPORTED_TOOLCHAIN } from "../src/infra/capabilities.js";
import { approvalFor, generateApproverKeys, signApproval } from "../src/infra/approvals.js";
import { MemoryOperationStore } from "../src/infra/stores/memory.js";

const now = () => new Date("2026-10-16T12:00:00Z");
const intent = { schemaVersion: 1, backend: "stripe-projects", environments: { production: { projectsBinding: "lohu", resources: {} } } } as const;
const binding = { trestleProjectId: "lohu", stripeAccountId: "acct_example123", projectsProjectId: "project_example123", projectsEnvironment: "default", generation: 1, resources: {} };
const capability = { ...capabilityFor("neon", "postgres", "link")!, evidence: "hosted_verified" as const, unknowns: [], observedAt: now().toISOString() };
const args = { intent, binding, environment: "production" as const, provider: "neon" as const, allowAccountCreation: true, acceptTerms: false, toolchain: SUPPORTED_TOOLCHAIN, now: now(), capability };
const status = (providers: { name: string; account_request_id: string; status: string }[]) => ({ project: { id: binding.projectsProjectId, merchant_id: binding.stripeAccountId }, active_environment: binding.projectsEnvironment, providers });
const completed = { name: "Neon", account_request_id: "facctrq_example123", status: "complete" };

async function setup() {
  const store = new MemoryOperationStore();
  const keys = generateApproverKeys();
  await store.registerApprover("greg", keys.publicKeyPem, ["production"], now());
  const plan = planProviderLink(args);
  const approval = signApproval(approvalFor(plan, { operationId: "op-link", approverId: "greg", now: now() }), keys.privateKeyPem);
  const adapter = {
    observe: vi.fn(async () => ({ status: "ok" as const, observation: { observedAt: now().toISOString(), stripeAccountId: binding.stripeAccountId, projectsProjectId: binding.projectsProjectId, projectsEnvironment: binding.projectsEnvironment, complete: true, resources: [] } })),
    mutate: vi.fn(async () => ({ status: "ok" as const, data: {} })),
    read: vi.fn(async () => ({ status: "ok" as const, authenticated: true, data: status([]) })),
  };
  adapter.mutate.mockImplementation(async () => { adapter.read.mockResolvedValue({ status: "ok", authenticated: true, data: status([completed]) }); return { status: "ok", data: {} }; });
  const deps = { store, adapter, workspace: "/private/fixture", toolchain: SUPPORTED_TOOLCHAIN, now, simulation: true, capability };
  return { store, keys, plan, approval, adapter, deps, input: { plan, approval, intent, binding } };
}

it("keeps unqualified and existing-only linking blocked, including with an approval flag", () => {
  expect(planProviderLink({ ...args, capability: undefined }).blockers.length).toBeGreaterThan(0);
  expect(planProviderLink({ ...args, allowAccountCreation: false }).blockers.join(" ")).toMatch(/existing-account-only/);
  expect(planProviderLink(args).operations[0]!.effects).toContain("remote_account_create");
  expect(planProviderLink({ ...args, acceptTerms: true }).operations[0]!.effects).toContain("remote_terms_acceptance");
});

it("records the grant before invoking the provider, verifies an association, and does not invent a provider account ID", async () => {
  const h = await setup();
  h.adapter.mutate.mockImplementationOnce(async () => {
    expect((await h.store.events("op-link")).at(-1)?.kind).toBe("infra.link.intent");
    h.adapter.read.mockResolvedValue({ status: "ok", authenticated: true, data: status([completed]) });
    return { status: "ok", data: {} };
  });
  expect((await applyProviderLink(h.input, h.deps)).outcome).toBe("succeeded");
  expect((await applyProviderLink(h.input, h.deps)).outcome).toBe("succeeded");
  expect(h.adapter.mutate).toHaveBeenCalledTimes(1);
  expect((await h.store.events("op-link")).find(e => e.kind === "infra.link.verified")?.data).toMatchObject({ connectionRequestId: "facctrq_example123", providerAccountIdentity: "not_proven" });
});

it("does not allow test capability evidence or a memory store to enable real linking", async () => {
  const h = await setup();
  expect((await applyProviderLink(h.input, { ...h.deps, simulation: false })).outcome).toBe("blocked");
  expect(h.adapter.mutate).not.toHaveBeenCalled();
});

it("checks signature, binding and fresh identity before granting anything", async () => {
  const h = await setup();
  expect((await applyProviderLink({ ...h.input, approval: { ...h.approval, signature: "forged" } }, h.deps)).outcome).toBe("blocked");
  expect((await applyProviderLink({ ...h.input, binding: { ...binding, generation: 2 } }, h.deps)).outcome).toBe("blocked");
  h.adapter.observe.mockResolvedValue({ status: "ok", observation: { observedAt: now().toISOString(), stripeAccountId: "acct_wrong123", projectsProjectId: binding.projectsProjectId, projectsEnvironment: "default", complete: true, resources: [] } });
  expect((await applyProviderLink(h.input, h.deps)).outcome).toBe("blocked");
  expect(h.adapter.mutate).not.toHaveBeenCalled();
});

it("keeps pending or unrecognized authorization uncertain and never resends it on resume", async () => {
  const h = await setup();
  h.adapter.mutate.mockImplementationOnce(async () => ({ status: "ok", data: {} }));
  h.adapter.read.mockResolvedValue({ status: "ok", authenticated: true, data: status([]) });
  expect((await applyProviderLink(h.input, h.deps)).outcome).toBe("outcome_unknown");
  expect((await applyProviderLink(h.input, h.deps)).outcome).toBe("outcome_unknown");
  expect(h.adapter.mutate).toHaveBeenCalledTimes(1);
  expect(await h.store.getReservation(`provider-link:${binding.stripeAccountId}:neon`)).toMatchObject({ state: "uncertain" });
  h.adapter.read.mockResolvedValue({ status: "ok", authenticated: true, data: status([completed]) });
  expect((await applyProviderLink(h.input, h.deps)).outcome).toBe("succeeded");
  expect(h.adapter.mutate).toHaveBeenCalledTimes(1);
});

it("retains sanitized native grant failure diagnostics without persisting authorization links", async () => {
  const h = await setup();
  h.adapter.mutate.mockRejectedValueOnce(new Error("lost https://auth.example/?code=private-code sk_live_ACCIDENTAL123456789"));
  expect((await applyProviderLink(h.input, h.deps)).outcome).toBe("outcome_unknown");
  const events = await h.store.events("op-link");
  expect(events.find(e => e.kind === "infra.link.result")?.data).toMatchObject({ status: "unknown", reason: expect.stringContaining("lost") });
  expect(JSON.stringify(events)).not.toMatch(/auth\.example|private-code|sk_live_/);
  expect((await applyProviderLink(h.input, h.deps)).outcome).toBe("outcome_unknown");
  expect(h.adapter.mutate).toHaveBeenCalledTimes(1);
});

it("observes an existing completed association without issuing another provider grant", async () => {
  const h = await setup();
  h.adapter.read.mockResolvedValue({ status: "ok", authenticated: true, data: status([completed]) });
  expect((await applyProviderLink(h.input, h.deps)).outcome).toBe("succeeded");
  expect(h.adapter.mutate).not.toHaveBeenCalled();
});

it.each(["pending", "unrecognized", "complete"])("keeps a complete plus %s association uncertain across resume without another grant", async secondStatus => {
  const h = await setup();
  h.adapter.mutate.mockImplementationOnce(async () => {
    h.adapter.read.mockResolvedValue({ status: "ok", authenticated: true, data: status([completed, { ...completed, account_request_id: "facctrq_second", status: secondStatus }]) });
    return { status: "ok", data: {} };
  });
  expect((await applyProviderLink(h.input, h.deps)).outcome).toBe("outcome_unknown");
  expect((await applyProviderLink(h.input, h.deps)).outcome).toBe("outcome_unknown");
  expect(await h.store.getReservation(`provider-link:${binding.stripeAccountId}:neon`)).toMatchObject({ state: "uncertain" });
  expect((await h.store.events("op-link")).some(event => event.kind === "infra.link.verified")).toBe(false);
  const otherApproval = signApproval(approvalFor(h.plan, { operationId: "op-other-grant", approverId: "greg", now: now() }), h.keys.privateKeyPem);
  expect((await applyProviderLink({ ...h.input, approval: otherApproval }, h.deps)).outcome).toBe("outcome_unknown");
  h.adapter.read.mockResolvedValue({ status: "ok", authenticated: true, data: status([completed]) });
  expect((await applyProviderLink(h.input, h.deps)).outcome).toBe("succeeded");
  expect(h.adapter.mutate).toHaveBeenCalledTimes(1);
});

it("refuses a provider-status document from another project before linking", async () => {
  const h = await setup();
  h.adapter.read.mockResolvedValue({ status: "ok", authenticated: true, data: { ...status([]), project: { id: "project_other", merchant_id: binding.stripeAccountId } } });
  expect((await applyProviderLink(h.input, h.deps)).outcome).toBe("blocked");
  expect(h.adapter.mutate).not.toHaveBeenCalled();
});
