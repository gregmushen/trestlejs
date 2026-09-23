import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { acceptsApiKeys, customerRoutePolicies, organizationCreatorAssignments, permissions, roleCatalogs, type Role, type RoutePolicy } from "../packages/authz/src/index.js";
import { features } from "../packages/billing/src/catalog.js";
import { defaultPlanVersions } from "../packages/billing/src/plans.js";

// Prints the application's access and commercial registries as one JSON
// document for `trestle permissions`, `trestle roles`, `trestle entitlements`,
// and `trestle admin doctor`. It never reads credentials or customer data.

const root = path.resolve(import.meta.dirname, "..");
const exists = (file: string) => access(file).then(() => true, () => false);
const problems: string[] = [];
const warnings: string[] = [];

type AdminViews = { valid: boolean; views: unknown[]; problems: string[] };

const policyView = (surface: "customer" | "admin") => (policy: RoutePolicy) => ({
  surface, method: policy.method, path: policy.path, audience: policy.audience,
  ...(policy.public ? { public: true } : {}),
  ...(policy.permission ? { permission: policy.permission } : {}),
  ...(policy.entitlement ? { entitlement: policy.entitlement } : {}),
  acceptsApiKeys: acceptsApiKeys(permissions, policy),
});

async function loadAdminRoutePolicies(): Promise<RoutePolicy[] | null> {
  const file = path.join(root, "apps", "admin", "worker", "route-policies.ts");
  if (!(await exists(file))) return null;
  try { return [...((await import(pathToFileURL(file).href)) as { platformRoutePolicies: readonly RoutePolicy[] }).platformRoutePolicies]; }
  catch (error) {
    warnings.push(`admin route policies could not be loaded: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
    return null;
  }
}

async function loadAdminViews(): Promise<AdminViews | null> {
  const directory = path.join(root, "apps", "admin");
  const script = path.join(directory, "scripts", "check-admin-views.ts");
  if (!(await exists(script))) return null;
  const result = spawnSync(process.execPath, ["--import", "tsx", script, "--json"], { cwd: directory, encoding: "utf8" });
  let document: unknown;
  try { document = JSON.parse(result.stdout); } catch { document = undefined; }
  const record = (document && typeof document === "object" ? document : {}) as Record<string, unknown>;
  const views = Array.isArray(record.views) ? record.views : [];
  const reported = Array.isArray(record.problems) ? record.problems.map(String) : [...(result.stderr ?? "").matchAll(/^\s+- (.+)$/gmu)].map((match) => match[1]!);
  if (result.status !== 0 && reported.length === 0) reported.push((result.stderr || result.stdout || `check-admin-views exited with ${String(result.status)}`).trim().split("\n").slice(0, 5).join("\n"));
  return { valid: result.status === 0 && reported.length === 0, views, problems: reported };
}

const roleView = (role: Role) => ({ key: role.key, name: role.name, description: role.description, plane: role.plane, permissions: [...role.permissions] });
const roles = { organization: roleCatalogs.organization.list().map(roleView), application: roleCatalogs.application.list().map(roleView), platform: roleCatalogs.platform.list().map(roleView) };
const allRoles = [...roles.organization, ...roles.application, ...roles.platform];
const grantedBy = (code: string) => allRoles.filter((role) => role.permissions.includes(code)).map((role) => `${role.plane}:${role.key}`);

for (const permission of permissions.list()) {
  if (permission.entitlement && !features.has(permission.entitlement)) problems.push(`permission ${permission.code} requires undefined feature ${permission.entitlement}`);
  if (permission.deprecated && grantedBy(permission.code).length) warnings.push(`deprecated permission ${permission.code} is still granted by default roles: ${grantedBy(permission.code).join(", ")}`);
}
for (const role of allRoles) {
  for (const code of role.permissions) {
    const permission = permissions.get(code);
    if (!permission) problems.push(`${role.plane} role ${role.key} grants unregistered permission ${code}`);
    else if (permission.plane !== role.plane) problems.push(`${role.plane} role ${role.key} grants ${permission.plane}-plane permission ${code}`);
  }
}
for (const assignment of organizationCreatorAssignments) {
  if (!roleCatalogs[assignment.plane].get(assignment.role)) problems.push(`bootstrap policy assigns unknown ${assignment.plane} role ${assignment.role}`);
}
for (const version of defaultPlanVersions) {
  for (const code of Object.keys(version.entitlements)) if (!features.has(code)) problems.push(`plan ${version.plan}@${version.version} references undefined feature ${code}`);
}

const adminPolicies = await loadAdminRoutePolicies();
// Generated tenant resources without explicit policies use this default (apps/worker/src/route-policies.ts).
const generatedResources = (["GET", "POST"] as const).map((method) => ({ surface: "customer" as const, method, path: "(generated tenant resources)", audience: "tenant", permission: method === "GET" ? "resource.read" : "resource.write", acceptsApiKeys: true }));
const routePolicies = [...customerRoutePolicies.map(policyView("customer")), ...generatedResources, ...(adminPolicies ?? []).map(policyView("admin"))];
for (const policy of [...customerRoutePolicies, ...(adminPolicies ?? [])]) {
  if (policy.entitlement && !features.has(policy.entitlement)) problems.push(`route ${policy.method} ${policy.path} requires undefined feature ${policy.entitlement}`);
}

const document = {
  schemaVersion: 2,
  permissions: permissions.list().map((permission) => ({ ...permission, principals: [...permission.principals], grantedBy: grantedBy(permission.code) })),
  roles,
  bootstrap: organizationCreatorAssignments,
  features: features.list(),
  plans: defaultPlanVersions,
  routePolicies,
  adminViews: await loadAdminViews(),
  consistency: { problems, warnings },
};

if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
else {
  process.stdout.write(`${document.permissions.length} permissions; roles: ${roles.organization.length} organization, ${roles.application.length} application, ${roles.platform.length} platform; ${document.features.length} features; ${document.plans.length} plan versions; ${routePolicies.length} route policies\n`);
  for (const problem of problems) process.stdout.write(`✗ ${problem}\n`);
  for (const warning of warnings) process.stdout.write(`! ${warning}\n`);
  if (problems.length) process.exitCode = 1;
}
