import { readFile } from "node:fs/promises";
import path from "node:path";

export type CiValidationCheck = {
  id: string;
  status: "pass" | "fail";
  message: string;
  evidence?: string;
};

export type CiValidationReport = {
  checks: CiValidationCheck[];
  valid: boolean;
};

const requiredWorkflows = ["ci.yml", "preview.yml", "deploy.yml", "secrets.yml", "diagnose.yml"] as const;

function check(id: string, condition: boolean, message: string, evidence?: string): CiValidationCheck {
  return { id, status: condition ? "pass" : "fail", message, ...(evidence ? { evidence } : {}) };
}

export async function validateCi(root: string): Promise<CiValidationReport> {
  const checks: CiValidationCheck[] = [];
  const sources = new Map<string, string>();
  for (const workflow of requiredWorkflows) {
    const relativePath = path.join(".github", "workflows", workflow);
    try {
      const source = await readFile(path.join(root, relativePath), "utf8");
      sources.set(workflow, source);
      checks.push(check(`ci.workflow.${workflow}.exists`, true, `${workflow} exists`, relativePath));
    } catch {
      checks.push(check(`ci.workflow.${workflow}.exists`, false, `${workflow} is missing`, relativePath));
    }
  }

  for (const [workflow, source] of sources) {
    const externalActions = [...source.matchAll(/^\s*-\s+uses:\s+([^@\s]+)@([^\s#]+)/gmu)]
      .filter(([, action]) => !action?.startsWith("./"));
    const unpinned = externalActions.filter(([, , reference]) => !/^[0-9a-f]{40}$/u.test(reference ?? ""));
    checks.push(check(
      `ci.workflow.${workflow}.actions-pinned`,
      unpinned.length === 0,
      unpinned.length === 0 ? `${workflow} pins external Actions to commit SHAs` : `${workflow} contains mutable Action references`,
      unpinned.map(([, action, reference]) => `${action}@${reference}`).join(", ") || undefined,
    ));
    checks.push(check(
      `ci.workflow.${workflow}.project-cli`,
      !source.includes("pnpm dlx trestlejs@"),
      !source.includes("pnpm dlx trestlejs@") ? `${workflow} does not download an unreviewed Trestle CLI` : `${workflow} bypasses the project-pinned Trestle CLI`,
    ));
  }

  const ci = sources.get("ci.yml") ?? "";
  checks.push(check("ci.database.rls", ci.includes("TRESTLE_RLS_TEST_DATABASE_URL"), "CI runs the PostgreSQL RLS test suite"));
  checks.push(check("ci.lockfile.frozen", ci.includes("pnpm install --frozen-lockfile"), "CI installs from the frozen lockfile"));

  const preview = sources.get("preview.yml") ?? "";
  checks.push(check(
    "ci.preview.trusted-only",
    preview.includes("github.event.pull_request.head.repo.full_name == github.repository"),
    "preview deployment is restricted to trusted repository branches",
  ));
  checks.push(check("ci.preview.environment", preview.includes("environment: preview"), "preview uses the protected preview environment"));
  checks.push(check("ci.preview.runtime-role", preview.includes("db:roles:configure") && preview.includes("db:roles:verify"), "preview configures and verifies a restricted database runtime role"));
  checks.push(check("ci.preview.isolated-cloudflare", preview.includes("--worker-name") && preview.includes("cloudflare-pages.mjs ensure"), "preview uses isolated Worker and Pages resources"));
  checks.push(check("ci.preview.cleanup", preview.includes("types: [opened, synchronize, reopened, closed]") && preview.includes("cloudflare-worker.mjs delete") && preview.includes("cloudflare-pages.mjs delete"), "closed pull requests clean up isolated Cloudflare resources"));
  checks.push(check("ci.preview.dynamic-smoke", preview.includes("steps.preview.outputs.api_url") && preview.includes("steps.preview.outputs.app_url") && preview.includes("steps.preview.outputs.site_url"), "preview smoke tests use derived per-PR URLs"));
  checks.push(check("ci.preview.deployment-evidence", (preview.match(/github-deployment\.mjs/gu) ?? []).length >= 2, "preview publishes and deactivates URL-bearing GitHub Deployments"));

  const deploy = sources.get("deploy.yml") ?? "";
  checks.push(check("ci.deploy.serialized", deploy.includes("cancel-in-progress: false"), "staging and production deployment is serialized"));
  checks.push(check("ci.deploy.promotion-gate", /production:[\s\S]*?needs:\s*staging/u.test(deploy), "production requires the staging job"));
  checks.push(check("ci.deploy.smoke", (deploy.match(/scripts\/smoke\.mjs/gu) ?? []).length >= 2, "staging and production run deployed smoke tests"));
  checks.push(check("ci.deploy.runtime-role", (deploy.match(/db:roles:configure/gu) ?? []).length >= 2 && (deploy.match(/db:roles:verify/gu) ?? []).length >= 2, "staging and production configure and verify restricted database runtime roles"));

  return { checks, valid: checks.every(({ status }) => status === "pass") };
}

export function formatCiValidation(report: CiValidationReport): string {
  return `${report.checks.map((item) => `${item.status === "pass" ? "✓" : "✗"} ${item.message}${item.evidence ? ` — ${item.evidence}` : ""}`).join("\n")}\n\n${report.valid ? "CI deployment contract is valid." : "CI deployment contract has failures."}\n`;
}
