import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { projectManifestSchema, TRESTLEJS_VERSION, type EnvironmentName, type ProjectManifest } from "@trestlejs/core";
import { parseDocument } from "yaml";

import { repairCommand } from "./capabilities.js";
import { runCommand } from "./processes.js";
import { CliFailure, type CliRuntime } from "./runtime.js";

export type AuthorityPlane = "organization" | "application" | "platform";
export const authorityPlanes: readonly AuthorityPlane[] = ["organization", "application", "platform"];

export type InspectedPermission = {
  code: string;
  description: string;
  principals: string[];
  plane: AuthorityPlane;
  group: string;
  entitlement?: string;
  deprecated?: string;
  grantedBy: string[];
};
export type InspectedRole = { key: string; name: string; description: string; plane: AuthorityPlane; permissions: string[] };
export type InspectedPrivilege = { type: string; description?: string; options?: string[]; minimum?: number; nullable?: boolean };
export type InspectedFeature = { code: string; name: string; description: string; privileges: Record<string, InspectedPrivilege>; metered?: { unit: string; period: string } };
export type InspectedPlanVersion = { plan: string; version: number; name: string; state: string; entitlements: Record<string, Record<string, unknown>> };
export type InspectedRoutePolicy = { surface: "customer" | "admin"; method: string; path: string; audience: string; public?: boolean; permission?: string; entitlement?: string; acceptsApiKeys: boolean };
export type InspectedAdminViews = { valid: boolean; views: unknown[]; problems: string[] };

export type AccessInspection = {
  schemaVersion: 2;
  permissions: InspectedPermission[];
  roles: Record<AuthorityPlane, InspectedRole[]>;
  bootstrap: Array<{ plane: AuthorityPlane; role: string }>;
  features: InspectedFeature[];
  plans: InspectedPlanVersion[];
  routePolicies: InspectedRoutePolicy[] | null;
  adminViews: InspectedAdminViews | null;
  consistency: { problems: string[]; warnings: string[] };
};

export const INSPECT_ACCESS_SCRIPT = path.join("scripts", "inspect-access.ts");

const exists = (file: string) => access(file).then(() => true, () => false);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function loadAccessInspection(root: string, runtime: Pick<CliRuntime, "run">): Promise<AccessInspection> {
  if (!(await exists(path.join(root, INSPECT_ACCESS_SCRIPT)))) {
    throw new CliFailure(`${INSPECT_ACCESS_SCRIPT} is missing. It ships with create-trestlejs ${TRESTLEJS_VERSION}; restore it from a freshly generated project, then run pnpm install.`);
  }
  let stdout: string;
  try {
    ({ stdout } = await (runtime.run ?? runCommand)("pnpm", ["exec", "tsx", INSPECT_ACCESS_SCRIPT, "--json"], { cwd: root, stdio: "pipe" }));
  } catch (error) {
    throw new CliFailure(`access inspection failed: ${message(error)}\nRun pnpm install, then fix the reported registry error in packages/authz or packages/billing.`);
  }
  let document: unknown;
  try { document = JSON.parse(stdout); } catch { throw new CliFailure(`${INSPECT_ACCESS_SCRIPT} did not print a JSON document`); }
  const value = document as Partial<AccessInspection> | null;
  if (!value || value.schemaVersion !== 2 || !Array.isArray(value.permissions) || !value.roles || !authorityPlanes.every((plane) => Array.isArray(value.roles?.[plane])) || !Array.isArray(value.features) || !Array.isArray(value.plans)) {
    throw new CliFailure(`${INSPECT_ACCESS_SCRIPT} printed an unsupported document; expected schemaVersion 2 with organization, application, and platform roles. Regenerate the script from create-trestlejs ${TRESTLEJS_VERSION}.`);
  }
  return {
    ...value,
    bootstrap: value.bootstrap ?? [],
    routePolicies: value.routePolicies ?? null,
    adminViews: value.adminViews ?? null,
    consistency: { problems: value.consistency?.problems ?? [], warnings: value.consistency?.warnings ?? [] },
  } as AccessInspection;
}

function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index]!))).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)];
}

// Permissions

export type PermissionReport = {
  plane: AuthorityPlane | "all";
  routePoliciesDeclared: boolean;
  permissions: Array<InspectedPermission & { enforcedBy: string[] | null }>;
  unenforced: string[];
  consistency: AccessInspection["consistency"];
};

export function permissionReport(inspection: AccessInspection, plane?: AuthorityPlane): PermissionReport {
  const policies = inspection.routePolicies;
  const permissions = inspection.permissions
    .filter((permission) => !plane || permission.plane === plane)
    .map((permission) => ({
      ...permission,
      enforcedBy: policies ? policies.filter((policy) => policy.permission === permission.code).map((policy) => `${policy.surface} ${policy.method} ${policy.path}`) : null,
    }));
  return {
    plane: plane ?? "all",
    routePoliciesDeclared: policies !== null,
    permissions,
    unenforced: policies ? permissions.filter((permission) => permission.enforcedBy?.length === 0).map((permission) => permission.code) : [],
    consistency: inspection.consistency,
  };
}

export function formatPermissions(report: PermissionReport): string {
  const rows = report.permissions.map((permission) => [
    permission.code,
    permission.plane,
    permission.principals.join(","),
    permission.entitlement ?? "-",
    permission.enforcedBy === null ? "?" : permission.enforcedBy.length ? permission.enforcedBy.join(", ") : "-",
    `${permission.description}${permission.deprecated ? ` (deprecated: ${permission.deprecated})` : ""}`,
  ]);
  const lines = [`Permissions (${report.permissions.length}${report.plane === "all" ? "" : `, ${report.plane} plane`})`, ...table(["CODE", "PLANE", "PRINCIPALS", "ENTITLEMENT", "ENFORCED BY", "DESCRIPTION"], rows)];
  if (!report.routePoliciesDeclared) lines.push("", "Route enforcement unknown: the route policy tables could not be loaded.");
  else if (report.unenforced.length) lines.push("", `Not required by any route policy (informational; these are checked inside handlers or reserved for product code): ${report.unenforced.join(", ")}`);
  for (const problem of report.consistency.problems) lines.push(`✗ ${problem}`);
  for (const warning of report.consistency.warnings) lines.push(`! ${warning}`);
  return `${lines.join("\n")}\n`;
}

// Roles

export type RoleSummary = InspectedRole & { permissionCount: number };
export type RoleReport = { planes: Partial<Record<AuthorityPlane, RoleSummary[]>>; bootstrap: AccessInspection["bootstrap"] } | { role: RoleSummary & { details: InspectedPermission[] } };

export function roleReport(inspection: AccessInspection, options: { plane?: AuthorityPlane; key?: string } = {}): RoleReport {
  const summary = (role: InspectedRole): RoleSummary => ({ ...role, permissionCount: role.permissions.length });
  const planes = options.plane ? [options.plane] : authorityPlanes;
  if (options.key !== undefined) {
    const candidates = planes.flatMap((plane) => inspection.roles[plane]);
    const role = candidates.find((candidate) => candidate.key === options.key);
    if (!role) throw new CliFailure(`role ${options.key} is not defined${options.plane ? ` in the ${options.plane} plane` : ""}; known roles: ${candidates.map((candidate) => `${candidate.plane}:${candidate.key}`).join(", ")}`);
    return { role: { ...summary(role), details: role.permissions.map((code) => inspection.permissions.find((permission) => permission.code === code) ?? { code, description: "(unregistered)", principals: [], plane: role.plane, group: "", grantedBy: [] }) } };
  }
  return { planes: Object.fromEntries(planes.map((plane) => [plane, inspection.roles[plane].map(summary)])), bootstrap: inspection.bootstrap };
}

const planeHeadings: Record<AuthorityPlane, string> = {
  organization: "Organization roles (account administration)",
  application: "Application roles (product-domain authority)",
  platform: "Platform roles (operating the SaaS)",
};

export function formatRoles(report: RoleReport): string {
  if ("role" in report) {
    const { role } = report;
    return `${[`${role.name} (${role.plane}:${role.key})`, role.description, "", ...table(["PERMISSION", "DESCRIPTION"], role.details.map((permission) => [permission.code, permission.description]))].join("\n")}\n`;
  }
  const lines: string[] = [];
  for (const plane of authorityPlanes) {
    const roles = report.planes[plane];
    if (!roles) continue;
    lines.push(planeHeadings[plane], ...table(["KEY", "NAME", "PERMISSIONS", "DESCRIPTION"], roles.map((role) => [role.key, role.name, String(role.permissionCount), role.description])), "");
  }
  if (report.bootstrap.length) lines.push(`Explicit cross-plane policy: an organization creator receives ${report.bootstrap.map((assignment) => `${assignment.plane}:${assignment.role}`).join(" and ")}.`);
  lines.push("Authority never flows between planes. Expand one role with --role <key>.");
  return `${lines.join("\n")}\n`;
}

// Entitlements

export type EntitlementReport = {
  features: InspectedFeature[];
  plans: Array<{ ref: string; plan: string; version: number; name: string; state: string }>;
  matrix: Array<{ feature: string; plans: Record<string, Record<string, unknown> | null> }>;
};

export function entitlementReport(inspection: AccessInspection): EntitlementReport {
  const plans = inspection.plans.map((version) => ({ ref: `${version.plan}@${version.version}`, plan: version.plan, version: version.version, name: version.name, state: version.state }));
  return {
    features: inspection.features,
    plans,
    matrix: inspection.features.map((feature) => ({
      feature: feature.code,
      plans: Object.fromEntries(inspection.plans.map((version) => [`${version.plan}@${version.version}`, version.entitlements[feature.code] ?? null])),
    })),
  };
}

function cell(values: Record<string, unknown> | null): string {
  if (values === null) return "-";
  const entries = Object.entries(values);
  return entries.length ? entries.map(([name, value]) => `${name}=${value === null ? "unlimited" : String(value)}`).join(" ") : "✓";
}

export function formatEntitlements(report: EntitlementReport): string {
  const features = table(["FEATURE", "NAME", "PRIVILEGES"], report.features.map((feature) => [
    feature.code,
    feature.name,
    Object.entries(feature.privileges).map(([name, privilege]) => `${name}:${privilege.type}${privilege.options ? `(${privilege.options.join("|")})` : ""}${privilege.nullable ? "?" : ""}`).join(" ") || "-",
  ]));
  const headers = ["FEATURE", ...report.plans.map((plan) => `${plan.ref} (${plan.state})`)];
  const matrix = table(headers, report.matrix.map((row) => [row.feature, ...report.plans.map((plan) => cell(row.plans[plan.ref] ?? null))]));
  return `${["Features", ...features, "", "Plan comparison", ...matrix].join("\n")}\n`;
}

// Admin views

export type AdminViewSummary = { id: string; path: string; group: string; label: string; order: number | null; permission: string; entitlement?: string; capability?: string };

export function adminViewSummaries(views: unknown[]): AdminViewSummary[] {
  return views.map((view) => {
    const value = (view && typeof view === "object" ? view : {}) as Record<string, unknown>;
    const navigation = (value.navigation && typeof value.navigation === "object" ? value.navigation : {}) as Record<string, unknown>;
    const text = (input: unknown) => (typeof input === "string" ? input : "");
    return {
      id: text(value.id),
      path: text(value.path),
      group: text(navigation.group ?? value.group),
      label: text(navigation.label ?? value.label),
      order: typeof (navigation.order ?? value.order) === "number" ? (navigation.order ?? value.order) as number : null,
      permission: text(value.permission),
      ...(typeof value.entitlement === "string" ? { entitlement: value.entitlement } : {}),
      ...(typeof value.capability === "string" ? { capability: value.capability } : {}),
    };
  });
}

export function formatAdminViews(views: AdminViewSummary[], problems: string[]): string {
  const lines = [`Admin views (${views.length})`, ...table(["ID", "PATH", "GROUP", "ORDER", "PERMISSION", "LABEL"], views.map((view) => [view.id, view.path, view.group, view.order === null ? "-" : String(view.order), view.permission, view.label]))];
  for (const problem of problems) lines.push(`✗ ${problem}`);
  return `${lines.join("\n")}\n`;
}

// Doctors

export type AccessCheck = { id: string; status: "pass" | "warn" | "fail"; message: string; evidence?: string; remediation?: string };
export type AccessDoctorReport = { name: string; environment: EnvironmentName; checks: AccessCheck[]; summary: { passed: number; warnings: number; failed: number } };

function summarize(name: string, environment: EnvironmentName, checks: AccessCheck[]): AccessDoctorReport {
  return {
    name,
    environment,
    checks,
    summary: {
      passed: checks.filter((check) => check.status === "pass").length,
      warnings: checks.filter((check) => check.status === "warn").length,
      failed: checks.filter((check) => check.status === "fail").length,
    },
  };
}

export function formatAccessDoctor(report: AccessDoctorReport): string {
  const lines = [`trestle ${report.name} (${report.environment})`, ""];
  for (const check of report.checks) {
    lines.push(`${check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗"} ${check.message}`);
    if (check.status !== "pass" && check.evidence) lines.push(`  Evidence: ${check.evidence}`);
    if (check.status !== "pass" && check.remediation) lines.push(`  Fix: ${check.remediation}`);
  }
  lines.push("", `${report.summary.passed} passed, ${report.summary.warnings} warnings, ${report.summary.failed} failed`);
  return `${lines.join("\n")}\n`;
}

/** Parses JSONC (comments and trailing commas) without evaluating anything. */
export function parseJsonc(source: string): unknown {
  let output = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\"") {
      let end = index + 1;
      while (end < source.length && source[end] !== "\"") end += source[end] === "\\" ? 2 : 1;
      output += source.slice(index, end + 1);
      index = end;
    } else if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
    } else if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 1;
    } else output += character;
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/gu, "$1"));
}

type WranglerConfig = { name?: string; main?: string; vars?: Record<string, unknown>; env?: Record<string, { name?: string; vars?: Record<string, unknown> }> };

async function readWrangler(file: string): Promise<WranglerConfig | undefined> {
  const source = await readFile(file, "utf8").catch(() => undefined);
  if (source === undefined) return undefined;
  try { return parseJsonc(source) as WranglerConfig; } catch { return {}; }
}

function effectiveWorker(config: WranglerConfig, environment: EnvironmentName): { name?: string; vars: Record<string, unknown> } {
  if (environment === "local") return { ...(config.name ? { name: config.name } : {}), vars: config.vars ?? {} };
  const scoped = config.env?.[environment];
  const name = scoped?.name ?? config.name;
  return { ...(name ? { name } : {}), vars: scoped?.vars ?? {} };
}

const configured = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value !== "CHANGE_ME";

export const ADMIN_WORKER_ENTRIES = ["worker/index.ts", "worker/src/index.ts", "src/worker.ts", "src/worker/index.ts"];

export async function runAdminDoctor(root: string, manifest: ProjectManifest, environment: EnvironmentName, runtime: Pick<CliRuntime, "run">): Promise<AccessDoctorReport> {
  const checks: AccessCheck[] = [];
  const repair = repairCommand(environment);
  const install = "pnpm exec trestle admin install";
  checks.push(manifest.capabilities.admin
    ? { id: "admin.capability.declared", status: "pass", message: "admin capability is declared" }
    : { id: "admin.capability.declared", status: "fail", message: "admin capability is not declared", evidence: ".trestle/project.yaml capabilities.admin", remediation: install });
  const adminPath = manifest.apps.admin;
  if (!adminPath) {
    checks.push({ id: "admin.app.declared", status: "fail", message: "apps.admin is not declared", evidence: ".trestle/project.yaml apps.admin", remediation: install });
  } else {
    checks.push({ id: "admin.app.declared", status: "pass", message: `admin application is declared at ${adminPath}` });
    for (const [id, file] of [["package", "package.json"], ["registry", "src/registry.ts"], ["check_script", "scripts/check-admin-views.ts"]] as const) {
      const relative = path.join(adminPath, file);
      checks.push(await exists(path.join(root, relative))
        ? { id: `admin.app.${id}`, status: "pass", message: `${relative} exists` }
        : { id: `admin.app.${id}`, status: "fail", message: `${relative} is missing`, remediation: `Restore the admin scaffold from create-trestlejs ${TRESTLEJS_VERSION}, then run ${install}` });
    }
    const entries = [];
    for (const entry of ADMIN_WORKER_ENTRIES) if (await exists(path.join(root, adminPath, entry))) entries.push(path.join(adminPath, entry));
    checks.push(entries.length
      ? { id: "admin.worker.entry", status: "pass", message: `admin Worker entry exists (${entries[0]})` }
      : { id: "admin.worker.entry", status: "fail", message: "admin Worker entry is missing", evidence: ADMIN_WORKER_ENTRIES.map((entry) => path.join(adminPath, entry)).join(", "), remediation: `Restore the admin Worker from create-trestlejs ${TRESTLEJS_VERSION}` });
    const adminConfig = await readWrangler(path.join(root, adminPath, "wrangler.jsonc"));
    const workerConfig = manifest.apps.worker ? await readWrangler(path.join(root, manifest.apps.worker, "wrangler.jsonc")) : undefined;
    if (!adminConfig) {
      checks.push({ id: "admin.worker.config", status: "fail", message: `${path.join(adminPath, "wrangler.jsonc")} is missing`, remediation: repair });
    } else {
      const admin = effectiveWorker(adminConfig, environment);
      const customer = workerConfig ? effectiveWorker(workerConfig, environment) : undefined;
      checks.push(!admin.name
        ? { id: "admin.worker.name", status: "fail", message: "admin Worker has no name", evidence: path.join(adminPath, "wrangler.jsonc"), remediation: repair }
        : customer?.name === admin.name
          ? { id: "admin.worker.name", status: "fail", message: `admin Worker name ${admin.name} is the customer Worker name`, remediation: `Give the admin Worker a distinct name in ${path.join(adminPath, "wrangler.jsonc")}` }
          : { id: "admin.worker.name", status: "pass", message: `admin Worker ${admin.name} is distinct from the customer Worker${customer?.name ? ` ${customer.name}` : ""}` });
      const adminOrigin = admin.vars.ADMIN_ORIGIN ?? customer?.vars.ADMIN_ORIGIN;
      const webOrigin = customer?.vars.WEB_ORIGIN ?? admin.vars.WEB_ORIGIN;
      if (configured(adminOrigin) && configured(webOrigin)) {
        checks.push(new URL(adminOrigin).origin === new URL(webOrigin).origin
          ? { id: "admin.origin.distinct", status: "fail", message: "ADMIN_ORIGIN equals WEB_ORIGIN; the admin surface must use its own origin", remediation: repair }
          : { id: "admin.origin.distinct", status: "pass", message: `admin origin ${new URL(adminOrigin).origin} is distinct from the customer origin` });
      } else {
        checks.push({ id: "admin.origin.distinct", status: environment === "local" ? "pass" : "warn", message: environment === "local" ? "local admin origin uses the development default" : `ADMIN_ORIGIN or WEB_ORIGIN is not configured for ${environment}`, remediation: repair });
      }
    }
  }

  try {
    const inspection = await loadAccessInspection(root, runtime);
    const views = inspection.adminViews;
    checks.push(views === null
      ? { id: "admin.views.valid", status: "warn", message: "admin view registry could not be checked", evidence: "apps/admin/scripts/check-admin-views.ts is absent", remediation: install }
      : views.valid
        ? { id: "admin.views.valid", status: "pass", message: `admin view registry is valid (${views.views.length} views)` }
        : { id: "admin.views.valid", status: "fail", message: "admin view registry is invalid", evidence: views.problems.join("; "), remediation: "Fix the reported admin-view descriptors under apps/admin/src/views" });
    const platform = inspection.permissions.filter((permission) => permission.plane === "platform");
    checks.push(platform.length
      ? { id: "authz.platform.registry", status: "pass", message: `${platform.length} platform-plane permissions are registered` }
      : { id: "authz.platform.registry", status: "fail", message: "no platform-plane permissions are registered", remediation: "Register platform.* permissions with plane: \"platform\" in packages/authz/src/permissions.ts" });
    const planeOf = new Map(inspection.permissions.map((permission) => [permission.code, permission.plane]));
    const leaks = authorityPlanes.flatMap((plane) => inspection.roles[plane].flatMap((role) => role.permissions.filter((code) => planeOf.get(code) !== plane).map((code) => `${plane}:${role.key} → ${code} (${planeOf.get(code) ?? "unregistered"})`)));
    checks.push(leaks.length
      ? { id: "authz.roles.plane_isolation", status: "fail", message: "roles grant permissions from another authority plane", evidence: leaks.join(", "), remediation: "Keep every role's permissions in its own plane in packages/authz/src/role-definitions.ts" }
      : { id: "authz.roles.plane_isolation", status: "pass", message: "every role grants permissions from its own authority plane only" });
    for (const problem of inspection.consistency.problems) checks.push({ id: "authz.consistency", status: "fail", message: problem });
  } catch (error) {
    checks.push({ id: "authz.inspection", status: "fail", message: "access registries could not be inspected", evidence: message(error), remediation: "pnpm install && pnpm exec tsx scripts/inspect-access.ts" });
  }
  return summarize("admin doctor", environment, checks);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(target));
    else if (/\.(?:ts|tsx|js|mjs)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) files.push(target);
  }
  return files;
}

const API_KEY_TABLE = /"?(api_keys?)"?/u.source;

export function plaintextApiKeyColumns(sql: string, schema: string): string[] {
  const findings: string[] = [];
  for (const match of sql.matchAll(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+(?:"?public"?\\.)?${API_KEY_TABLE}\\s*\\(([\\s\\S]*?)\\n\\);?`, "giu"))) {
    for (const column of match[2]!.matchAll(/^\s*"?(token|secret|plaintext|api_key|key)"?\s+\w/gimu)) findings.push(`${match[1]}.${column[1]} (migration)`);
  }
  for (const match of schema.matchAll(/pgTable\(\s*"(api_keys?)"\s*,\s*\{([\s\S]*?)\n\s*\}/gu)) {
    for (const column of match[2]!.matchAll(/^\s*(\w+)\s*:\s*\w+\(\s*"(token|secret|plaintext|key)"/gmu)) findings.push(`${match[1]}.${column[2]} (schema ${column[1]})`);
  }
  return findings;
}

export function authorizationLogLines(source: string): number[] {
  const lines: number[] = [];
  source.split("\n").forEach((line, index) => {
    if (/(?:\bconsole\.\w+|\blog(?:ger)?\.(?:debug|info|warn|error|trace|log)|\.log\.\w+)\s*\([^\n]*authorization/iu.test(line)) lines.push(index + 1);
  });
  return lines;
}

export async function runApiKeysDoctor(root: string, manifest: ProjectManifest, environment: EnvironmentName, runtime: Pick<CliRuntime, "run">): Promise<AccessDoctorReport> {
  const checks: AccessCheck[] = [];
  const authzPath = manifest.packages.authz ?? "packages/authz";
  const dbPath = manifest.packages.db ?? "packages/db";
  const apiKeysModule = path.join(authzPath, "src", "api-keys.ts");
  const moduleSource = await readFile(path.join(root, apiKeysModule), "utf8").catch(() => undefined);
  checks.push(moduleSource !== undefined
    ? { id: "api_keys.module", status: "pass", message: `${apiKeysModule} exists` }
    : { id: "api_keys.module", status: "fail", message: `${apiKeysModule} is missing`, remediation: `Restore the authz package from create-trestlejs ${TRESTLEJS_VERSION}` });
  if (!manifest.access?.apiKeys) checks.push({ id: "api_keys.declared", status: "warn", message: "access.apiKeys is not declared in .trestle/project.yaml", remediation: repairCommand(environment) });

  const migrationDirectory = path.join(root, dbPath, "migrations");
  const migrationFiles = (await readdir(migrationDirectory).catch(() => [] as string[])).filter((file) => file.endsWith(".sql")).sort();
  const sql = (await Promise.all(migrationFiles.map((file) => readFile(path.join(migrationDirectory, file), "utf8")))).join("\n");
  checks.push(/trestle_resolve_api_key/u.test(sql)
    ? { id: "api_keys.resolver", status: "pass", message: "migrations define trestle_resolve_api_key" }
    : { id: "api_keys.resolver", status: "fail", message: "no migration defines trestle_resolve_api_key", evidence: path.join(dbPath, "migrations"), remediation: "Add the access-control migration that creates the SECURITY DEFINER API-key resolver" });
  for (const [id, table] of [["api_key", "api_keys?"], ["service_account", "service_accounts?"]] as const) {
    const forced = new RegExp(`ALTER TABLE\\s+(?:"?public"?\\.)?"?${table}"?\\s+FORCE ROW LEVEL SECURITY`, "iu").test(sql);
    checks.push(forced
      ? { id: `api_keys.rls.${id}`, status: "pass", message: `${id} has FORCE ROW LEVEL SECURITY` }
      : { id: `api_keys.rls.${id}`, status: "fail", message: `${id} does not FORCE ROW LEVEL SECURITY in any migration`, remediation: `ALTER TABLE "${id}" FORCE ROW LEVEL SECURITY in a new migration` });
  }
  const schemaDirectory = path.join(root, dbPath, "src");
  const schema = (await Promise.all((await sourceFiles(schemaDirectory)).map((file) => readFile(file, "utf8")))).join("\n");
  const plaintext = plaintextApiKeyColumns(sql, schema);
  checks.push(plaintext.length
    ? { id: "api_keys.verifier_only", status: "fail", message: "API-key storage has a plaintext token column", evidence: plaintext.join(", "), remediation: "Store only the SHA-256 verifier; never persist the secret" }
    : { id: "api_keys.verifier_only", status: "pass", message: "API-key storage has no plaintext token or secret column" });

  const logFindings: string[] = [];
  for (const app of [manifest.apps.worker, manifest.apps.admin].filter((value): value is string => Boolean(value))) {
    for (const file of await sourceFiles(path.join(root, app))) {
      for (const line of authorizationLogLines(await readFile(file, "utf8"))) logFindings.push(`${path.relative(root, file)}:${line}`);
    }
  }
  checks.push(logFindings.length
    ? { id: "api_keys.no_authorization_logging", status: "fail", message: "Worker code passes Authorization header values to log calls", evidence: logFindings.join(", "), remediation: "Log the API-key public id or principal, never the Authorization header" }
    : { id: "api_keys.no_authorization_logging", status: "pass", message: "Worker code never logs Authorization headers" });

  if (moduleSource !== undefined) {
    checks.push(/api_key/u.test(moduleSource) && /principals/u.test(moduleSource)
      ? { id: "api_keys.scope_validation", status: "pass", message: "API-key scope validation checks permission principals" }
      : { id: "api_keys.scope_validation", status: "fail", message: "validateApiKeyScopes does not restrict scopes to api_key principals", evidence: apiKeysModule, remediation: "Reject scopes whose permission principals exclude api_key" });
  }
  try {
    const inspection = await loadAccessInspection(root, runtime);
    const eligible = inspection.permissions.filter((permission) => permission.principals.includes("api_key"));
    const invalid = eligible.filter((permission) => permission.plane !== "application").map((permission) => `${permission.code} (${permission.plane})`);
    checks.push(invalid.length
      ? { id: "api_keys.scopes", status: "fail", message: "non-application permissions allow api_key principals", evidence: invalid.join(", "), remediation: "Service accounts hold application roles only; machine access to organization or platform permissions is not enabled by default" }
      : eligible.length
        ? { id: "api_keys.scopes", status: "pass", message: `${eligible.length} permissions are eligible as API-key scopes`, evidence: eligible.map((permission) => permission.code).join(", ") }
        : { id: "api_keys.scopes", status: "warn", message: "no permission allows api_key principals; API keys cannot be scoped to anything", remediation: "Add \"api_key\" to the principals of permissions machines may use" });
    const routeLeaks = (inspection.routePolicies ?? []).filter((policy) => policy.acceptsApiKeys && policy.permission && !eligible.some((permission) => permission.code === policy.permission && permission.plane === "application"));
    if (routeLeaks.length) checks.push({ id: "api_keys.routes", status: "fail", message: "routes accept API keys for permissions outside the machine-capable application plane", evidence: routeLeaks.map((policy) => `${policy.surface} ${policy.method} ${policy.path}`).join(", ") });
  } catch (error) {
    checks.push({ id: "api_keys.scopes", status: "fail", message: "API-key scope eligibility could not be inspected", evidence: message(error), remediation: "pnpm install && pnpm exec tsx scripts/inspect-access.ts" });
  }
  return summarize("api-keys doctor", environment, checks);
}

// Admin install

export async function installAdmin(root: string, manifest: ProjectManifest): Promise<{ changed: boolean; adminPath: string }> {
  const adminPath = manifest.apps.admin ?? "apps/admin";
  const missing = [];
  for (const file of ["package.json", "src/registry.ts"]) if (!(await exists(path.join(root, adminPath, file)))) missing.push(path.join(adminPath, file));
  if (missing.length) {
    throw new CliFailure(`the admin scaffold is missing (${missing.join(", ")}).\nIt ships with create-trestlejs ${TRESTLEJS_VERSION} or newer. Generate a reference project with \`pnpm create trestlejs@${TRESTLEJS_VERSION} <temporary-directory>\`, copy its ${adminPath} directory into this project, run pnpm install, then rerun \`pnpm exec trestle admin install\`.`);
  }
  const manifestPath = path.join(root, ".trestle", "project.yaml");
  const source = await readFile(manifestPath, "utf8");
  const document = parseDocument(source);
  let changed = false;
  if (document.getIn(["capabilities", "admin"]) !== true) { document.setIn(["capabilities", "admin"], true); changed = true; }
  if (document.getIn(["apps", "admin"]) !== adminPath) { document.setIn(["apps", "admin"], adminPath); changed = true; }
  const result = projectManifestSchema.safeParse(document.toJS());
  if (!result.success) throw new CliFailure(`admin install would produce an invalid manifest: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  if (!changed) return { changed: false, adminPath };
  await writeFile(manifestPath, document.toString(), "utf8");
  return { changed: true, adminPath };
}
