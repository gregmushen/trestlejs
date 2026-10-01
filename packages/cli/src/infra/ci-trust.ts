import { parse as parseYaml } from "yaml";

/**
 * CI trust boundary for infrastructure mutation (spec §24, §27; AR-06).
 * Privileged jobs must be unreachable from untrusted triggers, run behind a
 * protected environment, and never execute dependency lifecycle scripts or
 * untrusted pull-request code. This is defense in depth: branch rules that
 * require review of workflow changes remain the primary control, because a
 * pull request could also edit this validator.
 */

const PRIVILEGED = /\btrestle\b(?:\s+--experimental)?\s+infra\s+(?:apply|approve|operation\s+resume|approver\s+register)\b/u;
const UNTRUSTED_TRIGGERS = new Set(["pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment", "issue_comment", "workflow_run", "discussion_comment"]);
const INSTALL = /\b(?:pnpm|npm|yarn|bun)\s+(?:install|ci|i|add)\b/u;

type Step = { run?: unknown; uses?: unknown; with?: Record<string, unknown> };
type Job = { environment?: unknown; steps?: Step[] };

function triggers(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

export function infraWorkflowIssues(file: string, source: string): string[] {
  let document: { on?: unknown; true?: unknown; jobs?: Record<string, Job> };
  try {
    document = parseYaml(source) as typeof document;
  } catch {
    return source.includes("infra") ? [`${file}: workflow is not valid YAML; infrastructure trust cannot be verified`] : [];
  }
  // YAML 1.1 parsers read a bare `on:` key as boolean true.
  const events = triggers(document.on ?? document.true);
  const untrusted = events.filter((event) => UNTRUSTED_TRIGGERS.has(event));
  const issues: string[] = [];
  if (untrusted.length && source.includes("TRESTLE_INFRA_CONTROL_DATABASE_URL")) issues.push(`${file}: the control-store secret is referenced in a workflow triggered by ${untrusted.join(", ")}`);
  for (const [name, job] of Object.entries(document.jobs ?? {})) {
    const steps = job.steps ?? [];
    const runs = steps.map((step) => (typeof step.run === "string" ? step.run : ""));
    if (!runs.some((run) => PRIVILEGED.test(run))) continue;
    if (untrusted.length) issues.push(`${file}#${name}: privileged infrastructure job is reachable from untrusted trigger ${untrusted.join(", ")}`);
    if (!job.environment) issues.push(`${file}#${name}: privileged infrastructure job must run in a protected GitHub environment`);
    for (const run of runs) {
      if (INSTALL.test(run) && !/--ignore-scripts\b/u.test(run)) issues.push(`${file}#${name}: installs dependencies with lifecycle scripts in a privileged job; build in a separate job and pass an immutable artifact`);
      if (/\$\{\{\s*github\.event\.(?:pull_request|issue|comment)/u.test(run)) issues.push(`${file}#${name}: interpolates untrusted event data into a privileged command`);
      if (/\b(?:pnpm|npm|yarn)\s+(?:run\s+)?(?:build|test|exec|dlx)\b|\bnpx\b/u.test(run)) issues.push(`${file}#${name}: runs application code in a privileged job; separate build/test from mutation`);
    }
    for (const step of steps) {
      const ref = String(step.with?.ref ?? "");
      if (typeof step.uses === "string" && step.uses.startsWith("actions/checkout") && /pull_request|head/u.test(ref)) issues.push(`${file}#${name}: checks out pull-request head code in a privileged job`);
    }
  }
  return issues;
}
