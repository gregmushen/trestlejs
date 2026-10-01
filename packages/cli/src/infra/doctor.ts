import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { StripeProjectsAdapter, ToolchainCheck } from "./adapters/stripe-projects.js";
import { planInfrastructure } from "./planner.js";
import { INFRA_PATHS, type InfraEnvironment, type InfrastructureBindings, type InfrastructureIntent } from "./schema.js";

/**
 * Read-only infrastructure readiness (spec §26, AR-09). Doctor runs only
 * read-only Projects commands, never pulls credential values, and reports
 * active verification as recorded evidence rather than executing it.
 */

export type DoctorStatus = "pass" | "fail" | "unknown" | "not_applicable";
export type DoctorCheck = Readonly<{ id: string; status: DoctorStatus; detail: string }>;

export type DoctorInput = Readonly<{
  root: string;
  environment: InfraEnvironment;
  intent: InfrastructureIntent;
  bindings: InfrastructureBindings;
  toolchain: ToolchainCheck;
  adapter?: StripeProjectsAdapter;
  now: Date;
}>;

export function projectsWorkspace(root: string, environment: InfraEnvironment): string {
  return path.join(root, INFRA_PATHS.local, "projects", environment);
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}

export async function runInfraDoctor(input: DoctorInput): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const binding = input.bindings.environments[input.environment];

  checks.push(input.toolchain.ok
    ? { id: "toolchain", status: "pass", detail: `Projects plugin ${input.toolchain.toolchain.pluginVersion} matches the qualified executable` }
    : { id: "toolchain", status: input.toolchain.reasons.some((reason) => reason.includes("hash")) ? "fail" : "unknown", detail: input.toolchain.reasons.join("; ") });

  checks.push(input.intent.environments[input.environment]
    ? { id: "intent", status: "pass", detail: `${Object.keys(input.intent.environments[input.environment]!.resources).length} resource(s) declared` }
    : { id: "intent", status: "fail", detail: `${input.environment} is not declared in ${INFRA_PATHS.intent}` });

  checks.push(binding
    ? { id: "binding", status: "pass", detail: `bound to ${binding.stripeAccountId} / ${binding.projectsProjectId} (${binding.projectsEnvironment}), generation ${binding.generation}` }
    : { id: "binding", status: "fail", detail: `no reviewed Projects binding for ${input.environment}` });

  const workspace = projectsWorkspace(input.root, input.environment);
  if (!binding || !(await exists(path.join(workspace, ".projects")))) {
    checks.push({ id: "projects-status", status: "not_applicable", detail: "no linked Projects workspace for this environment" });
  } else if (!input.adapter) {
    checks.push({ id: "projects-status", status: "unknown", detail: "Projects toolchain is unavailable; remote state was not inspected" });
  } else {
    const result = await input.adapter.read("status", [], workspace);
    if (result.status === "ok") checks.push(result.authenticated === false ? { id: "projects-status", status: "unknown", detail: "Projects session is not authenticated" } : { id: "projects-status", status: "pass", detail: "Projects status read succeeded" });
    else if (result.status === "provider_error") checks.push({ id: "projects-status", status: result.code === "NO_PROJECT_CONFIG" ? "fail" : "unknown", detail: `${result.code}: ${result.message}` });
    else checks.push({ id: "projects-status", status: "unknown", detail: result.reason });
  }

  if (input.intent.environments[input.environment]) {
    const plan = planInfrastructure({ intent: input.intent, bindings: input.bindings, environment: input.environment, ...(input.toolchain.ok ? { toolchain: input.toolchain.toolchain } : {}), now: input.now });
    const blocked = plan.operations.filter((operation) => operation.classification === "blocked");
    checks.push({ id: "plan", status: blocked.length > 0 || plan.blockers.length > 0 ? "fail" : "unknown", detail: blocked.length > 0 || plan.blockers.length > 0 ? `${blocked.length} blocked operation(s), ${plan.blockers.length} plan blocker(s); run trestle infra plan for details` : "offline plan has no blockers; live observation required to confirm" });
    checks.push({ id: "orphans", status: plan.orphans.length > 0 ? "fail" : "pass", detail: plan.orphans.length > 0 ? `bound but undeclared: ${plan.orphans.join(", ")} (never deleted automatically)` : "no orphaned bindings" });
  }

  const operations = path.join(input.root, INFRA_PATHS.local, "operations");
  const pending = await readdir(operations).catch(() => [] as string[]);
  checks.push(pending.length > 0 ? { id: "operations", status: "fail", detail: `${pending.length} unresolved operation record(s); run trestle infra operation show <id>` } : { id: "operations", status: "pass", detail: "no unresolved local operation records" });

  checks.push({ id: "credentials", status: "not_applicable", detail: "Projects-managed credential snapshots are not enabled" });
  checks.push({ id: "active-verification", status: "unknown", detail: "no separately authorized verification evidence (RLS, deployed consumers) is recorded; doctor does not run write probes" });
  return checks;
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  const symbol: Record<DoctorStatus, string> = { pass: "✓", fail: "✗", unknown: "?", not_applicable: "-" };
  return `${checks.map((check) => `${symbol[check.status]} ${check.id}: ${check.detail}`).join("\n")}\n`;
}
