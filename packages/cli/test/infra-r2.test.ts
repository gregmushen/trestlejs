import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers/infra-harness.js";
import { parseIntent } from "../src/infra/schema.js";
import { applyPlan } from "../src/infra/runner.js";
import { resolveCapability, SUPPORTED_TOOLCHAIN } from "../src/infra/capabilities.js";
import { capabilityFor } from "../src/infra/capability-matrix.js";
import { readFile } from "node:fs/promises";
import { serviceConfiguration } from "../src/infra/configuration.js";

let h: Harness;
afterEach(async () => { await h?.cleanup(); });
const intent = (limit: number) => parseIntent(JSON.stringify({ schemaVersion: 1, backend: "stripe-projects", environments: { staging: { projectsBinding: "staging-infra", ignoredOutputs: ["CLOUDFLARE_TOKEN"], resources: { artifacts: { provider: "cloudflare", service: "r2:bucket", configuration: { name: "fixture-artifacts", location_hint: "wnam" }, lifecycleOwner: "stripe-projects", directWriterDisabled: true, costLimit: { currency: "usd", monthlyMinor: limit } } } } } }));

it("matches the current catalog's required name and optional location-hint contract without admitting arbitrary JSON", async () => {
  const recorded = JSON.parse(await readFile(new URL("./fixtures/stripe-projects/0.45.0/cloudflare-r2-configuration.json", import.meta.url), "utf8")) as { configuration_schema: { required: string[]; properties: { location_hint: { enum: string[] } } } };
  expect(recorded.configuration_schema.required).toEqual(["name"]);
  for (const hint of recorded.configuration_schema.properties.location_hint.enum) expect(serviceConfiguration("cloudflare", "r2:bucket", { name: "fixture-artifacts", location_hint: hint })).toEqual({ name: "fixture-artifacts", location_hint: hint });
  for (const value of [{}, { name: "$(id)" }, { name: "fixture-artifacts", location_hint: "unsupported" }, { name: "fixture-artifacts", command: "unexpected" }]) expect(() => serviceConfiguration("cloudflare", "r2:bucket", value)).toThrow();
  expect(() => serviceConfiguration("neon", "postgres", { name: "fixture-artifacts" })).toThrow();
});

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
  expect(JSON.parse(create!.args[create!.args.indexOf("--config") + 1]!)).toEqual({ name: "fixture-artifacts", location_hint: "wnam" });
  expect((await h.store.readGeneration("bindings:trestle-proj-1:staging"))?.data.binding).toMatchObject({ resources: { artifacts: { provider: "cloudflare", service: "r2:bucket", externalId: expect.any(String) } } });
});

it("requires explicit bucket configuration, rejects unsupported configuration and detects a requested rename", async () => {
  h = await createHarness();
  const desired = intent(100);
  const noConfig = JSON.parse(JSON.stringify(desired)); delete noConfig.environments.staging.resources.artifacts.configuration;
  expect((await h.plan(parseIntent(JSON.stringify(noConfig)))).operations[0]!.blockers.join(" ")).toMatch(/configuration.name/);
  const badConfig = JSON.parse(JSON.stringify(desired)); badConfig.environments.staging.resources.artifacts.configuration.command = "unsafe";
  expect(() => parseIntent(JSON.stringify(badConfig))).toThrow(/configuration/);
  const plan = await h.plan(desired);
  expect((await applyPlan({ plan, approval: h.approve(plan), intent: desired, bindings: h.bindings }, h.deps())).outcome).toBe("succeeded");
  const committed = await h.store.readGeneration("bindings:trestle-proj-1:staging");
  const edited = JSON.parse(JSON.stringify(desired)); edited.environments.staging.resources.artifacts.configuration.name = "another-bucket";
  const observed = await h.adapter.observe(h.workspace, h.clock.now());
  if (observed.status !== "ok") throw new Error("fake observation failed");
  const { planInfrastructure } = await import("../src/infra/planner.js");
  const result = planInfrastructure({ intent: parseIntent(JSON.stringify(edited)), bindings: { ...h.bindings, environments: { staging: committed!.data.binding as typeof h.bindings.environments.staging } }, environment: "staging", toolchain: h.toolchain, observation: observed.observation, now: h.clock.now(), capabilities: h.capabilities });
  expect(result.operations[0]!.blockers.join(" ")).toMatch(/configuration changed/);
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
