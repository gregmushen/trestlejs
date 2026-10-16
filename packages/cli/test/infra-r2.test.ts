import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers/infra-harness.js";
import { parseIntent } from "../src/infra/schema.js";
import { applyPlan } from "../src/infra/runner.js";
import { resolveCapability, SUPPORTED_TOOLCHAIN } from "../src/infra/capabilities.js";
import { capabilityFor } from "../src/infra/capability-matrix.js";

let h: Harness;
afterEach(async () => { await h?.cleanup(); });
const intent = (limit: number) => parseIntent(JSON.stringify({ schemaVersion: 1, backend: "stripe-projects", environments: { staging: { projectsBinding: "staging-infra", ignoredOutputs: ["CLOUDFLARE_TOKEN"], resources: { artifacts: { provider: "cloudflare", service: "r2:bucket", lifecycleOwner: "stripe-projects", directWriterDisabled: true, costLimit: { currency: "usd", monthlyMinor: limit } } } } } }));

it("keeps real R2 qualification blocked and refuses a zero-dollar paid-service authorization", async () => {
  expect(resolveCapability(capabilityFor("cloudflare", "r2:bucket", "create")!, SUPPORTED_TOOLCHAIN, new Date("2026-10-16T00:00:00Z")).allowed).toBe(false);
  h = await createHarness();
  const plan = await h.plan(intent(0));
  expect(plan.operations[0]?.classification).toBe("blocked");
  expect(plan.operations[0]?.blockers.join(" ")).toMatch(/positive costLimit/);
});

it("includes paid-service confirmation only in the cost-approved create and binds its exact ID", async () => {
  h = await createHarness();
  const desired = intent(100);
  const plan = await h.plan(desired);
  const approval = h.approve(plan);
  expect(approval.payload.costLimit).toEqual({ currency: "usd", monthlyMinor: 100 });
  const result = await applyPlan({ plan, approval, intent: desired, bindings: h.bindings }, h.deps());
  expect(result.outcome).toBe("succeeded");
  const create = (await h.fake.calls()).find(call => call.args.includes("cloudflare/r2:bucket"));
  expect(create?.args).toContain("--confirm-paid-service");
  expect((await h.store.readGeneration("bindings:trestle-proj-1:staging"))?.data.binding).toMatchObject({ resources: { artifacts: { provider: "cloudflare", service: "r2:bucket", externalId: expect.any(String) } } });
});

it("reconciles a lost R2 response without sending a second add or authorizing another bucket", async () => {
  h = await createHarness();
  await h.fake.setBehavior({ faults: [{ command: "add", stage: "after", kind: "lose-response" }] });
  const desired = intent(100);
  const plan = await h.plan(desired);
  const approval = h.approve(plan);
  expect((await applyPlan({ plan, approval, intent: desired, bindings: h.bindings }, h.deps())).outcome).toBe("outcome_unknown");
  expect((await applyPlan({ plan, approval, intent: desired, bindings: h.bindings }, h.deps())).outcome).toBe("succeeded");
  expect((await h.fake.remote()).effects.add).toBe(1);
});
