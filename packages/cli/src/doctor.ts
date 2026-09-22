import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { wranglerEnvironmentBlock, wranglerStringVariable } from "./wrangler-config.js";

import { parseSetupPlan, structuredOutput, type EnvironmentName, type ProjectManifest } from "@trestlejs/core";

import { validateCi } from "./ci.js";
import { inspectResources } from "./inspect.js";
import { diffSetupPlan } from "./plan.js";
import { readSecrets, validateSecrets } from "./secrets.js";

export type DoctorCheck = {
  id: string;
  group: "project" | "architecture";
  status: "pass" | "fail";
  message: string;
  evidence?: string;
  remediation?: string;
};

export type DoctorReport = {
  environment: EnvironmentName;
  checks: DoctorCheck[];
  summary: {
    passed: number;
    warnings: number;
    failed: number;
  };
};

async function pathCheck(
  root: string,
  kind: "app" | "package",
  name: string,
  relativePath: string,
): Promise<DoctorCheck> {
  const absolutePath = path.join(root, relativePath);
  try {
    await access(absolutePath);
    return {
      id: `project.${kind}.${name}.exists`,
      group: "project",
      status: "pass",
      message: `${kind} ${name} exists`,
      evidence: relativePath,
    };
  } catch {
    return {
      id: `project.${kind}.${name}.exists`,
      group: "project",
      status: "fail",
      message: `${kind} ${name} is missing`,
      evidence: relativePath,
      remediation: `Create ${relativePath} or update .trestle/project.yaml`,
    };
  }
}

export async function runDoctor(
  root: string,
  manifest: ProjectManifest,
  environment: EnvironmentName,
  masterKey?: string,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    {
      id: "project.manifest.valid",
      group: "project",
      status: "pass",
      message: "project manifest is valid",
      evidence: ".trestle/project.yaml (schemaVersion 1)",
    },
  ];

  if (!manifest.environments.includes(environment)) {
    checks.push({
      id: "project.environment.declared",
      group: "project",
      status: "fail",
      message: `environment ${environment} is not declared`,
      remediation: `Add ${environment} to environments in .trestle/project.yaml`,
    });
  } else {
    checks.push({
      id: "project.environment.declared",
      group: "project",
      status: "pass",
      message: `environment ${environment} is declared`,
    });
  }

  const entries = [
    ...Object.entries(manifest.apps).map(([name, relativePath]) => ({
      kind: "app" as const,
      name,
      relativePath,
    })),
    ...Object.entries(manifest.packages).map(([name, relativePath]) => ({
      kind: "package" as const,
      name,
      relativePath,
    })),
  ];
  checks.push(
    ...(await Promise.all(
      entries.map(({ kind, name, relativePath }) => pathCheck(root, kind, name, relativePath)),
    )),
  );

  checks.push(await pathCheck(root, "package", "trestle-setup skill", path.join(".agents", "skills", "trestle-setup", "SKILL.md")));

  try {
    await access(path.join(root, ".github", "workflows"));
    const ci = await validateCi(root);
    checks.push(...ci.checks.map((item) => ({
      id: item.id,
      group: "architecture" as const,
      status: item.status,
      message: item.message,
      ...(item.evidence ? { evidence: item.evidence } : {}),
      ...(item.status === "fail" ? { remediation: "Run trestle ci validate and repair the generated deployment contract" } : {}),
    })));
  } catch {
    checks.push({ id: "ci.workflows.optional", group: "architecture", status: "pass", message: "no GitHub Actions deployment contract is present" });
  }

  const setupPlanPath = path.join(root, ".trestle", "setup.json");
  try {
    const input = await readFile(setupPlanPath, "utf8");
    const plan = parseSetupPlan(input);
    const diff = await diffSetupPlan(root, manifest, plan, input);
    checks.push({
      id: "setup.plan.converged",
      group: "architecture",
      status: diff.converged ? "pass" : "fail",
      message: diff.converged ? "SetupPlan is valid and converged" : "SetupPlan has pending, blocked, or unknown changes",
      evidence: diff.converged ? setupPlanPath : diff.items.filter(({ classification }) => classification !== "already correct").map(({ classification, id }) => `${classification}:${id}`).join(", "),
      ...(!diff.converged ? { remediation: "Review trestle plan diff .trestle/setup.json, then explicitly approve trestle apply .trestle/setup.json --yes" } : {}),
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      checks.push({ id: "setup.plan.optional", group: "architecture", status: "pass", message: "no SetupPlan is currently declared" });
    } else {
      checks.push({ id: "setup.plan.valid", group: "architecture", status: "fail", message: "SetupPlan cannot be validated", evidence: error instanceof Error ? error.message : String(error), remediation: "Run trestle plan validate .trestle/setup.json" });
    }
  }

  try {
    const resources = await inspectResources(root);
    const migrationDirectory = path.join(root, manifest.packages.db ?? "packages/db", "migrations");
    const migrationSql = resources.length
      ? (await Promise.all((await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).map((file) => readFile(path.join(migrationDirectory, file), "utf8")))).join("\n")
      : "";
    for (const resource of resources) {
      const required = resource.files ?? [resource.contracts, resource.persistence?.schema].filter((value): value is string => Boolean(value));
      const missing = (await Promise.all(required.map(async (relativePath) => access(path.join(root, relativePath)).then(() => undefined, () => relativePath)))).filter(Boolean);
      checks.push({
        id: `resources.${resource.name.toLowerCase()}.sources`,
        group: "architecture",
        status: missing.length ? "fail" : "pass",
        message: missing.length ? `${resource.name} resource sources are incomplete` : `${resource.name} resource declaration and sources agree`,
        ...(missing.length ? { evidence: missing.join(", "), remediation: `Regenerate or restore the declared ${resource.name} source files` } : {}),
      });
      if (resource.persistence?.table) {
        const table = resource.persistence.table;
        const migrated = migrationSql.includes(`CREATE TABLE "${table}"`) && migrationSql.includes(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
        checks.push({
          id: `resources.${resource.name.toLowerCase()}.migration`,
          group: "architecture",
          status: migrated ? "pass" : "fail",
          message: migrated ? `${resource.name} has a journaled forced-RLS migration` : `${resource.name} migration is missing or does not force RLS`,
          ...(!migrated ? { remediation: "Run pnpm db:generate and ensure the migration forces row-level security before applying it" } : {}),
        });
      }
    }
  } catch (error) {
    checks.push({ id: "resources.declarations.valid", group: "architecture", status: "fail", message: "resource declarations cannot be read", evidence: error instanceof Error ? error.message : String(error) });
  }

  if (manifest.site) {
    const sitePath = manifest.apps.site;
    const appPath = manifest.apps.app;
    if (!sitePath) {
      checks.push({
        id: "site.app.declared",
        group: "architecture",
        status: "fail",
        message: "site support is enabled but apps.site is not declared",
        remediation: "Declare apps.site in .trestle/project.yaml",
      });
    } else {
      checks.push(
        await pathCheck(root, "app", "site Astro configuration", path.join(sitePath, "astro.config.mjs")),
        await pathCheck(root, "app", "site package manifest", path.join(sitePath, "package.json")),
        await pathCheck(root, "app", "site Cloudflare configuration", path.join(sitePath, "wrangler.jsonc")),
      );
      try {
        const [astroConfig, sitePackage, siteConfig, header, cloudflareConfig] = await Promise.all([
          readFile(path.join(root, sitePath, "astro.config.mjs"), "utf8"),
          readFile(path.join(root, sitePath, "package.json"), "utf8"),
          readFile(path.join(root, sitePath, "src", "config", "site.ts"), "utf8"),
          readFile(path.join(root, sitePath, "src", "components", "Header.astro"), "utf8"),
          readFile(path.join(root, sitePath, "wrangler.jsonc"), "utf8"),
        ]);
        const configured =
          astroConfig.includes('output: "static"') &&
          sitePackage.includes('"astro"') &&
          siteConfig.includes("appLink") &&
          header.includes("APP_URL") &&
          cloudflareConfig.includes('"directory": "./dist"');
        checks.push({
          id: "site.configuration.valid",
          group: "architecture",
          status: configured ? "pass" : "fail",
          message: configured
            ? "Astro site, APP_URL handoff, and Cloudflare static deployment are configured"
            : "site configuration is incomplete",
          ...(!configured
            ? { remediation: "Restore the Astro static config, APP_URL handoff, and Cloudflare dist asset configuration" }
            : {}),
        });
      } catch (error) {
        checks.push({
          id: "site.configuration.valid",
          group: "architecture",
          status: "fail",
          message: "site configuration cannot be read",
          evidence: error instanceof Error ? error.message : String(error),
        });
      }
    }
    checks.push({
      id: "site.application.declared",
      group: "architecture",
      status: appPath ? "pass" : "fail",
      message: appPath ? "authenticated application is declared separately from the public site" : "apps.app is not declared",
      ...(!appPath ? { remediation: "Declare the authenticated TanStack application as apps.app" } : {}),
    });
  }

  if (manifest.secrets && Object.keys(manifest.secrets).length > 0) {
    try {
      const values = await readSecrets(root, environment, masterKey);
      const problems = validateSecrets(values, manifest, environment);
      checks.push({
        id: "configuration.secrets.valid",
        group: "architecture",
        status: problems.length === 0 ? "pass" : "fail",
        message: problems.length === 0 ? `${environment} encrypted credentials are valid` : `${environment} encrypted credentials are invalid`,
        ...(problems.length > 0 ? { evidence: problems.join("; "), remediation: `Run trestle secrets edit --env ${environment}` } : {}),
      });
    } catch (error) {
      checks.push({
        id: "configuration.secrets.valid",
        group: "architecture",
        status: "fail",
        message: `${environment} encrypted credentials cannot be read`,
        evidence: error instanceof Error ? error.message : String(error),
        remediation: `Run trestle secrets init --env ${environment}`,
      });
    }
  }

  if (manifest.packages.integrations) {
    checks.push(await pathCheck(root, "package", "transactional email", path.join(manifest.packages.integrations, "src", "email", "index.ts")));
    if (environment === "staging" || environment === "production") {
      for (const name of ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"] as const) {
        const declaration = manifest.secrets?.[name];
        checks.push({
          id: `email.secret.${name.toLowerCase()}.declared`,
          group: "architecture",
          status: declaration?.target === "worker" && declaration.required.includes(environment) ? "pass" : "fail",
          message: declaration?.target === "worker" && declaration.required.includes(environment) ? `${name} is required for ${environment}` : `${name} is not declared as a required ${environment} Worker secret`,
          ...(!declaration || declaration.target !== "worker" || !declaration.required.includes(environment) ? { remediation: `Declare ${name} as a Worker secret required in ${environment}` } : {}),
        });
      }
      try {
        const workerPath = manifest.apps.worker;
        if (!workerPath) throw new Error("worker app is not declared");
        const workerConfig = await readFile(path.join(root, workerPath, "wrangler.jsonc"), "utf8");
        const environmentBlock = wranglerEnvironmentBlock(workerConfig, environment);
        const configured = wranglerStringVariable(environmentBlock, "EMAIL_DELIVERY_MODE") === "resend" && Boolean(wranglerStringVariable(environmentBlock, "EMAIL_FROM") && wranglerStringVariable(environmentBlock, "EMAIL_FROM") !== "CHANGE_ME") && (environment !== "staging" || Boolean(wranglerStringVariable(environmentBlock, "EMAIL_STAGING_REDIRECT") && wranglerStringVariable(environmentBlock, "EMAIL_STAGING_REDIRECT") !== "CHANGE_ME"));
        checks.push({
          id: "email.provider.configuration",
          group: "architecture",
          status: configured ? "pass" : "fail",
          message: configured ? `Resend and a sender are configured for ${environment}` : `${environment} email provider configuration is incomplete`,
          ...(!configured ? { remediation: `Set EMAIL_FROM${environment === "staging" ? ", EMAIL_STAGING_REDIRECT," : " and"} the ${environment} Resend adapter variables in ${workerPath}/wrangler.jsonc` } : {}),
        });
      } catch (error) {
        checks.push({ id: "email.provider.configuration", group: "architecture", status: "fail", message: "email deployment configuration cannot be read", evidence: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  if (manifest.packages.billing) {
    checks.push(await pathCheck(root, "package", "billing", path.join(manifest.packages.billing, "src", "index.ts")));
    if (environment === "staging" || environment === "production") {
      for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const) {
        const declaration = manifest.secrets?.[name];
        const valid = declaration?.target === "worker" && declaration.required.includes(environment);
        checks.push({ id: `billing.secret.${name.toLowerCase()}.declared`, group: "architecture", status: valid ? "pass" : "fail", message: valid ? `${name} is required for ${environment}` : `${name} is not declared as a required ${environment} Worker secret`, ...(!valid ? { remediation: `Declare ${name} as a Worker secret required in ${environment}` } : {}) });
      }
      try {
        const workerPath = manifest.apps.worker;
        if (!workerPath) throw new Error("worker app is not declared");
        const workerConfig = await readFile(path.join(root, workerPath, "wrangler.jsonc"), "utf8");
        const block = wranglerEnvironmentBlock(workerConfig, environment);
        const expectedMode = environment === "production" ? "live" : "test";
        const valid = wranglerStringVariable(block, "STRIPE_MODE") === expectedMode && Boolean(wranglerStringVariable(block, "STRIPE_PRICES")) && Boolean(wranglerStringVariable(block, "STRIPE_PUBLISHABLE_KEY") && wranglerStringVariable(block, "STRIPE_PUBLISHABLE_KEY") !== "CHANGE_ME");
        checks.push({ id: "billing.stripe.configuration", group: "architecture", status: valid ? "pass" : "fail", message: valid ? `Stripe ${expectedMode} configuration is declared` : `${environment} Stripe configuration is incomplete`, ...(!valid ? { remediation: `Configure Stripe ${expectedMode} publishable key, prices, and return URL in ${workerPath}/wrangler.jsonc` } : {}) });
      } catch (error) {
        checks.push({ id: "billing.stripe.configuration", group: "architecture", status: "fail", message: "Stripe deployment configuration cannot be read", evidence: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const passed = checks.filter((check) => check.status === "pass").length;
  const failed = checks.filter((check) => check.status === "fail").length;
  return {
    environment,
    checks,
    summary: { passed, warnings: 0, failed },
  };
}

export function formatDoctorHuman(report: DoctorReport): string {
  const groups = new Map<string, DoctorCheck[]>();
  for (const check of report.checks) {
    const existing = groups.get(check.group) ?? [];
    existing.push(check);
    groups.set(check.group, existing);
  }

  const lines = [`trestle doctor (${report.environment})`];
  for (const [group, checks] of groups) {
    lines.push("", group[0]?.toUpperCase() + group.slice(1));
    for (const check of checks) {
      lines.push(`${check.status === "pass" ? "✓" : "✗"} ${check.message}`);
      if (check.status === "fail" && check.remediation) {
        lines.push(`  Fix: ${check.remediation}`);
      }
    }
  }
  lines.push(
    "",
    `${report.summary.passed} passed, ${report.summary.warnings} warnings, ${report.summary.failed} failed`,
  );
  return `${lines.join("\n")}\n`;
}

export function formatDoctorJson(report: DoctorReport): string {
  return `${JSON.stringify(structuredOutput(report), null, 2)}\n`;
}
