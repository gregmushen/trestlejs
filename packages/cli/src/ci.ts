import { readFile } from "node:fs/promises";
import path from "node:path";
import { wranglerEnvironmentBlock } from "./wrangler-config.js";

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

const requiredWorkflows = ["ci.yml", "preview.yml", "deploy.yml", "secrets.yml", "diagnose.yml", "providers.yml", "backup-verify.yml"] as const;

function check(id: string, condition: boolean, message: string, evidence?: string): CiValidationCheck {
  return { id, status: condition ? "pass" : "fail", message, ...(evidence ? { evidence } : {}) };
}

function occursInOrder(source: string, first: string, second: string): boolean {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  return firstIndex >= 0 && secondIndex > firstIndex;
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
  checks.push(check("ci.database.async", ci.includes("TRESTLE_INBOX_TEST_DATABASE_URL") && ci.includes("TRESTLE_INBOX_TEST_ADMIN_DATABASE_URL"), "CI runs durable inbox and outbox integration tests"));
  checks.push(check("ci.system.local", ci.includes("TRESTLE_SYSTEM_TEST_DATABASE_URL"), "CI runs the local authentication and tenancy system test"));
  checks.push(check("ci.lockfile.frozen", ci.includes("pnpm install --frozen-lockfile"), "CI installs from the frozen lockfile"));
  checks.push(check("ci.architecture.static", ci.includes("trestle architecture check"), "CI enforces provider boundaries, resource integrity, forced RLS, and managed-guidance freshness"));
  const workerConfig = await readFile(path.join(root, "apps", "worker", "wrangler.jsonc"), "utf8").catch(() => "");
  for (const environment of ["preview", "staging", "production"] as const) {
    const block = wranglerEnvironmentBlock(workerConfig, environment);
    const required = ["DATABASE_URL", "DATABASE_DRIVER", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];
    const declared = block.match(/"secrets"\s*:\s*\{\s*"required"\s*:\s*\[([^\]]*)\]/u)?.[1] ?? "";
    checks.push(check(`ci.worker.${environment}.secrets`, required.every((name) => declared.includes(`"${name}"`)), `${environment} Worker declares required runtime secrets in its own Wrangler environment`));
  }

  const providers = sources.get("providers.yml") ?? "";
  const providerTests = await readFile(path.join(root, "packages", "integrations", "src", "provider.integration.test.ts"), "utf8").catch(() => "");
  const providerConfig = await readFile(path.join(root, "packages", "integrations", "src", "provider-staging-config.ts"), "utf8").catch(() => "");
  checks.push(check("ci.providers.protected", providers.includes("environment: staging") && providers.includes("workflow_dispatch"), "provider verification is manual and protected by the staging environment"));
  checks.push(check("ci.providers.encrypted-secrets", providers.includes("trestle secrets check --env staging")
    && providers.includes("trestle doctor --env staging")
    && providers.includes("trestle secrets get RESEND_API_KEY --env staging --raw")
    && providers.includes("trestle secrets get STRIPE_SECRET_KEY --env staging --raw")
    && providers.includes('TRESTLE_MASTER_KEY: "${{ secrets.TRESTLE_MASTER_KEY }}"')
    && !providers.includes("secrets.RESEND_API_KEY") && !providers.includes("secrets.STRIPE_SECRET_KEY"), "protected provider verification reads Trestle encrypted staging credentials, not duplicate GitHub provider secrets"));
  checks.push(check("ci.providers.safety", providers.includes("TRESTLE_PROVIDER_INTEGRATION_TESTS")
    && providers.includes("provider.integration.test.ts") && providerTests.includes("EMAIL_STAGING_REDIRECT")
    && providerTests.includes("STRIPE_MODE") && providerTests.includes("sk_test_")
    && providerTests.includes("readStagingProviderVariables") && providerConfig.includes("apps/worker/wrangler.jsonc"), "provider verification checks the declared Resend staging redirect and Stripe test mode"));

  const preview = sources.get("preview.yml") ?? "";
  checks.push(check(
    "ci.preview.trusted-only",
    preview.includes("github.event.pull_request.head.repo.full_name == github.repository"),
    "preview deployment is restricted to trusted repository branches",
  ));
  checks.push(check("ci.preview.environment", preview.includes("environment: preview"), "preview uses the protected preview environment"));
  checks.push(check("ci.preview.runtime-role", preview.includes("bootstrap-managed") && preview.includes("db:roles:configure") && preview.includes("db:roles:verify"), "preview bootstraps, configures, and verifies a restricted database runtime role"));
  checks.push(check("ci.preview.migrate-before-role", occursInOrder(preview, "Bootstrap restricted preview runtime role", "Migrate preview database") && occursInOrder(preview, "Migrate preview database", "Configure preview database roles"), "preview bootstraps its runtime login, then migrates before configuring database roles"));
  checks.push(check("ci.preview.isolated-cloudflare", preview.includes("--worker-name") && preview.includes("cloudflare-pages.mjs ensure"), "preview uses isolated Worker and Pages resources"));
  checks.push(check("ci.preview.cleanup", preview.includes("types: [opened, synchronize, reopened, closed]") && preview.includes("cloudflare-worker.mjs delete") && preview.includes("cloudflare-pages.mjs delete"), "closed pull requests clean up isolated Cloudflare resources"));
  checks.push(check("ci.preview.dynamic-smoke", preview.includes("steps.preview.outputs.api_url") && preview.includes("steps.preview.outputs.app_url") && preview.includes("steps.preview.outputs.site_url"), "preview smoke tests use derived per-PR URLs"));
  checks.push(check("ci.preview.operational-smoke", preview.includes("TRESTLE_DEPLOY_ENV: preview"), "preview smoke verifies the Worker operational environment"));
  checks.push(check("ci.preview.deployment-evidence", (preview.match(/github-deployment\.mjs/gu) ?? []).length >= 2, "preview publishes and deactivates URL-bearing GitHub Deployments"));
  checks.push(check("ci.preview.isolated-database", preview.includes("neon-preview.mjs ensure") && preview.includes("neon-preview.mjs delete") && preview.includes("steps.runtime-role.outputs.runtime_url"), "preview provisions, configures, uses, and deletes an isolated Neon branch"));
  checks.push(check("ci.preview.provider-preflight", preview.includes("cloudflare-preflight.mjs") && /^\s+node scripts\/neon-preflight\.mjs\s*$/mu.test(preview) && /- id: cloudflare_access\n\s+name:[^\n]+\n\s+continue-on-error: true/u.test(preview) && /- id: neon_access\n\s+name:[^\n]+\n\s+continue-on-error: true/u.test(preview) && occursInOrder(preview, "Verify Cloudflare access before provisioning", "Verify Neon project access before provisioning") && occursInOrder(preview, "Verify Neon project access before provisioning", "Require both provider access checks") && occursInOrder(preview, "Require both provider access checks", "Validate preview configuration") && occursInOrder(preview, "Validate preview configuration", "Provision isolated Neon branch") && preview.includes("steps.cloudflare_access.outcome") && preview.includes("steps.neon_access.outcome") && preview.includes('CLOUDFLARE_WORKERS_SUBDOMAIN: "${{ vars.CLOUDFLARE_WORKERS_SUBDOMAIN }}"'), "preview independently verifies Cloudflare and Neon access before configuration gates and provisioning"));
  checks.push(check("ci.preview.encrypted-neon-credential", (preview.match(/trestle secrets get NEON_API_KEY --env preview --raw/gu) ?? []).length >= 2 && !preview.includes("secrets.NEON_API_KEY"), "preview creation and teardown use the declared encrypted Neon CI credential"));
  checks.push(check("ci.preview.dynamic-auth-url", preview.includes("Bind Better Auth to the isolated preview application") && preview.includes("steps.preview.outputs.app_url") && preview.includes("secret put BETTER_AUTH_URL"), "preview binds Better Auth to its isolated application URL"));
  checks.push(check("ci.preview.queues", preview.includes("queue-config.mjs render preview") && preview.includes("cloudflare-queues.mjs ensure") && preview.includes("cloudflare-queues.mjs delete-preview") && preview.includes("deploy --config .trestle-queues.wrangler.jsonc --env preview"), "preview prepares isolated Queue bindings, provisions Queues, and cleans them up"));
  checks.push(check("ci.preview.r2", preview.includes("cloudflare-r2.mjs ensure") && preview.includes("cloudflare-r2.mjs delete-preview") && occursInOrder(preview, "Prepare isolated preview Queue bindings", "Provision isolated preview R2 bucket") && occursInOrder(preview, "Provision isolated preview R2 bucket", "Provision isolated Neon branch"), "preview prepares an opt-in isolated R2 bucket and cleans up only empty buckets"));

  const deploy = sources.get("deploy.yml") ?? "";
  checks.push(check("ci.deploy.serialized", deploy.includes("cancel-in-progress: false"), "staging and production deployment is serialized"));
  checks.push(check("ci.deploy.promotion-gate", /production:[\s\S]*?needs:\s*staging/u.test(deploy), "production requires the staging job"));
  checks.push(check("ci.deploy.smoke", (deploy.match(/scripts\/smoke\.mjs/gu) ?? []).length >= 2, "staging and production run deployed smoke tests"));
  checks.push(check("ci.deploy.operational-smoke", deploy.includes("TRESTLE_DEPLOY_ENV: staging") && deploy.includes("TRESTLE_DEPLOY_ENV: production"), "staging and production smoke verify their operational environments"));
  checks.push(check("ci.deploy.queues", deploy.includes("queue-config.mjs render staging") && deploy.includes("queue-config.mjs render production") && (deploy.match(/cloudflare-queues\.mjs ensure/gu) ?? []).length >= 2 && (deploy.match(/deploy --config \.trestle-queues\.wrangler\.jsonc/gu) ?? []).length >= 2, "staging and production prepare and provision opt-in Queues"));
  checks.push(check("ci.deploy.r2", (deploy.match(/cloudflare-r2\.mjs ensure/gu) ?? []).length >= 2 && occursInOrder(deploy, "Prepare staging Queue bindings", "Provision staging R2 bucket") && occursInOrder(deploy, "Prepare production Queue bindings", "Provision production R2 bucket"), "staging and production provision opt-in R2 buckets"));
  checks.push(check("ci.deploy.runtime-role", (deploy.match(/db:roles:bootstrap/gu) ?? []).length >= 2 && (deploy.match(/db:roles:configure/gu) ?? []).length >= 2 && (deploy.match(/db:roles:verify/gu) ?? []).length >= 2, "staging and production bootstrap, configure, and verify restricted database runtime roles"));
  checks.push(check(
    "ci.deploy.migrate-before-role",
    occursInOrder(deploy, "Bootstrap staging runtime role", "Migrate staging")
      && occursInOrder(deploy, "Migrate staging", "Configure staging database roles")
      && occursInOrder(deploy, "Bootstrap production runtime role", "Migrate production")
      && occursInOrder(deploy, "Migrate production", "Configure production database roles"),
    "staging and production bootstrap runtime logins, then migrate before configuring database roles",
  ));

  const backup = sources.get("backup-verify.yml") ?? "";
  checks.push(check("ci.backup.scheduled", backup.includes("schedule:") && backup.includes("workflow_dispatch:"), "backup restore verification is scheduled and manually runnable"));
  checks.push(check("ci.backup.protected", backup.includes("environment: production") && backup.includes("cancel-in-progress: false"), "backup restore verification uses the protected production environment and cannot overlap"));
  checks.push(check("ci.backup.isolated", backup.includes("backup verify --env production --to restore-test --yes") && backup.includes("NEON_PROJECT_ID") && backup.includes("DATABASE_RUNTIME_ROLE"), "backup verification restores to the declared isolated target with migration and runtime role checks"));
  checks.push(check("ci.backup.r2", backup.includes("CLOUDFLARE_ACCOUNT_ID") && backup.includes("TRESTLE_MASTER_KEY"), "protected backup verification can resolve R2 recovery credentials and account identity"));
  checks.push(check("ci.backup.evidence", backup.includes("recovery-evidence.json") && backup.includes("GITHUB_STEP_SUMMARY"), "backup verification records non-secret recovery evidence"));

  return { checks, valid: checks.every(({ status }) => status === "pass") };
}

export function formatCiValidation(report: CiValidationReport): string {
  return `${report.checks.map((item) => `${item.status === "pass" ? "✓" : "✗"} ${item.message}${item.evidence ? ` — ${item.evidence}` : ""}`).join("\n")}\n\n${report.valid ? "CI deployment contract is valid." : "CI deployment contract has failures."}\n`;
}
