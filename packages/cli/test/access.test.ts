import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { executeCli, generatePermission, installAdmin, permissionEntry } from "../src/index.js";
import { loadProjectManifest } from "@trestlejs/core";

const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../create/template");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const manifest = (admin: boolean) => `schemaVersion: 1
project:
  name: fixture
apps:
  app: apps/app
  worker: apps/worker
${admin ? "  admin: apps/admin\n" : ""}packages:
  authz: packages/authz
  billing: packages/billing
  db: packages/db
tenancy:
  model: organization
  enforcement: postgres-rls
database:
  engine: postgresql
  defaultProvider: neon
capabilities:
  # keep this comment
  r2: false
  queues: false
  workflows: false
  durableObjects: false
  admin: ${admin}
access:
  customRoles: true
  serviceAccounts: true
  apiKeys: true
environments: [local, staging, production]
`;

async function project(options: { admin?: boolean; scaffold?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-access-"));
  directories.push(root);
  await mkdir(path.join(root, ".trestle"), { recursive: true });
  await writeFile(path.join(root, ".trestle", "project.yaml"), manifest(options.admin ?? true));
  for (const directory of ["apps/app", "apps/worker/src", "packages/authz/src", "packages/billing/src", "packages/db/src", "packages/db/migrations", "scripts"]) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, "packages/authz/src/permissions.ts"), await readFile(path.join(template, "packages/authz/src/permissions.ts"), "utf8"));
  await writeFile(path.join(root, "packages/authz/src/api-keys.ts"), await readFile(path.join(template, "packages/authz/src/api-keys.ts"), "utf8"));
  await writeFile(path.join(root, "packages/billing/src/catalog.ts"), await readFile(path.join(template, "packages/billing/src/catalog.ts"), "utf8"));
  await writeFile(path.join(root, "scripts/inspect-access.ts"), "// fixture\n");
  await writeFile(path.join(root, "apps/worker/wrangler.jsonc"), `{ "name": "fixture-worker", "vars": { "WEB_ORIGIN": "http://localhost:42069" } }`);
  if (options.scaffold ?? true) {
    for (const directory of ["apps/admin/src/views", "apps/admin/scripts", "apps/admin/worker"]) await mkdir(path.join(root, directory), { recursive: true });
    for (const file of ["apps/admin/package.json", "apps/admin/src/registry.ts", "apps/admin/scripts/check-admin-views.ts", "apps/admin/worker/index.ts"]) await writeFile(path.join(root, file), "{}\n");
    await writeFile(path.join(root, "apps/admin/src/navigation.ts"), "export const applicationNavigationGroups: readonly string[] = [];\n");
    await writeFile(path.join(root, "apps/admin/wrangler.jsonc"), `{ // admin\n "name": "fixture-admin", "vars": { "ADMIN_ORIGIN": "http://localhost:42070" }, }`);
  }
  return root;
}

const role = (plane: string, key: string, permissions: string[]) => ({ key, name: key, description: `${key} role`, plane, permissions });
const inspection = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  permissions: [
    { code: "organization.members.invite", plane: "organization", description: "Invite members", principals: ["user"], group: "organization.members", grantedBy: ["organization:owner"] },
    { code: "resource.read", plane: "application", description: "Read resources", principals: ["user", "api_key"], group: "resource", grantedBy: ["application:reader"] },
    { code: "platform.jobs.redrive", plane: "platform", description: "Redrive jobs", principals: ["user"], group: "platform.jobs", grantedBy: ["platform:platform_operator"] },
  ],
  roles: { organization: [role("organization", "owner", ["organization.members.invite"])], application: [role("application", "reader", ["resource.read"])], platform: [role("platform", "platform_operator", ["platform.jobs.redrive"])] },
  bootstrap: [{ plane: "organization", role: "owner" }, { plane: "application", role: "app_admin" }],
  features: [{ code: "api.access", name: "API access", description: "", privileges: { maxKeys: { type: "integer" } } }],
  plans: [{ plan: "pro", version: 1, name: "Pro", state: "active", entitlements: { "api.access": { maxKeys: 5 } } }],
  routePolicies: [
    { surface: "customer", method: "PUT", path: "/api/tenant/members/:id/organization-roles", audience: "tenant", permission: "organization.members.invite", acceptsApiKeys: false },
    { surface: "admin", method: "POST", path: "/api/admin/async/dead/:id/redrive", audience: "platform", permission: "platform.jobs.redrive", acceptsApiKeys: false },
  ],
  adminViews: { valid: true, views: [{ id: "overview", path: "/", navigation: { label: "Overview", group: "Overview", order: 10 }, permission: "platform.overview.read" }], problems: [] },
  consistency: { problems: [], warnings: [] },
  ...overrides,
});

function capture(root: string, document: unknown = inspection()) {
  let stdout = "";
  let stderr = "";
  const calls: string[][] = [];
  return {
    runtime: {
      cwd: () => root,
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
      isTTY: () => false,
      run: async (command: string, arguments_: string[]) => { calls.push([command, ...arguments_]); return { stdout: JSON.stringify(document), stderr: "" }; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
    calls,
  };
}

describe("access inspection commands", () => {
  it("reports permissions by plane with enforcement discovery", async () => {
    const root = await project();
    const output = capture(root);
    expect(await executeCli(["permissions", "--plane", "organization"], output.runtime)).toBe(0);
    expect(output.calls[0]).toEqual(["pnpm", "exec", "tsx", "scripts/inspect-access.ts", "--json"]);
    expect(output.stdout()).toContain("organization.members.invite  organization");
    expect(output.stdout()).toContain("customer PUT /api/tenant/members/:id/organization-roles");
    expect(output.stdout()).not.toContain("resource.read");
    const json = capture(root);
    expect(await executeCli(["permissions", "--json"], json.runtime)).toBe(0);
    expect(JSON.parse(json.stdout())).toMatchObject({ schemaVersion: 1, data: { plane: "all", permissions: expect.arrayContaining([expect.objectContaining({ code: "platform.jobs.redrive", enforcedBy: ["admin POST /api/admin/async/dead/:id/redrive"] })]) } });
    expect(await executeCli(["permissions", "--plane", "tenant"], capture(root).runtime)).not.toBe(0);
  });

  it("fails when the registries are inconsistent", async () => {
    const root = await project();
    const output = capture(root, inspection({ consistency: { problems: ["organization role owner grants application-plane permission resource.read"], warnings: [] } }));
    expect(await executeCli(["permissions"], output.runtime)).toBe(1);
    expect(output.stdout()).toContain("✗ organization role owner grants application-plane permission resource.read");
  });

  it("groups roles by plane, explains the bootstrap policy, and expands one role", async () => {
    const root = await project();
    const all = capture(root);
    expect(await executeCli(["roles"], all.runtime)).toBe(0);
    expect(all.stdout()).toMatch(/Organization roles[\s\S]*Application roles[\s\S]*Platform roles/u);
    expect(all.stdout()).toContain("organization:owner and application:app_admin");
    const one = capture(root);
    expect(await executeCli(["roles", "--plane", "application", "--role", "reader"], one.runtime)).toBe(0);
    expect(one.stdout()).toContain("reader (application:reader)");
    expect(await executeCli(["roles", "--plane", "platform", "--role", "reader"], capture(root).runtime)).toBe(1);
  });

  it("prints features and the plan comparison matrix", async () => {
    const root = await project();
    const output = capture(root);
    expect(await executeCli(["entitlements"], output.runtime)).toBe(0);
    expect(output.stdout()).toContain("maxKeys:integer");
    expect(output.stdout()).toContain("maxKeys=5");
  });

  it("rejects an outdated inspection document", async () => {
    const root = await project();
    const output = capture(root, { ...inspection(), schemaVersion: 1 });
    expect(await executeCli(["roles"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("expected schemaVersion 2");
  });
});

describe("admin and API-key doctors", () => {
  it("passes a well-formed admin surface and fails a missing one", async () => {
    const root = await project();
    const output = capture(root);
    expect(await executeCli(["admin", "doctor"], output.runtime)).toBe(0);
    expect(output.stdout()).toContain("✓ every role grants permissions from its own authority plane only");
    expect(output.stdout()).toContain("fixture-admin is distinct from the customer Worker fixture-worker");
    const missing = await project({ admin: false, scaffold: false });
    const failed = capture(missing);
    expect(await executeCli(["admin", "doctor"], failed.runtime)).toBe(1);
    expect(failed.stdout()).toContain("✗ admin capability is not declared");
  });

  it("detects cross-plane role grants", async () => {
    const root = await project();
    const output = capture(root, inspection({ roles: { organization: [role("organization", "owner", ["resource.read"])], application: [], platform: [] } }));
    expect(await executeCli(["admin", "doctor"], output.runtime)).toBe(1);
    expect(output.stdout()).toContain("organization:owner → resource.read (application)");
  });

  it("checks API-key storage, RLS, logging, and scope eligibility", async () => {
    const root = await project();
    await writeFile(path.join(root, "packages/db/migrations/0006.sql"), `CREATE TABLE "api_key" (\n\t"id" text PRIMARY KEY NOT NULL,\n\t"verifier" text NOT NULL\n);\nALTER TABLE "api_key" FORCE ROW LEVEL SECURITY;\nALTER TABLE "service_account" FORCE ROW LEVEL SECURITY;\nCREATE FUNCTION trestle_resolve_api_key(p text) RETURNS void AS $$ $$ LANGUAGE sql;\n`);
    const passing = capture(root);
    expect(await executeCli(["api-keys", "doctor"], passing.runtime)).toBe(0);
    expect(passing.stdout()).toContain("✓ 1 permissions are eligible as API-key scopes");
    await writeFile(path.join(root, "apps/worker/src/leak.ts"), "log.info(\"request\", { authorization: headers.get(\"authorization\") });\n");
    await writeFile(path.join(root, "packages/db/migrations/0007.sql"), `CREATE TABLE "api_keys" (\n\t"token" text NOT NULL\n);\n`);
    const failing = capture(root, inspection({ permissions: [{ code: "organization.members.invite", plane: "organization", description: "x", principals: ["user", "api_key"], group: "organization", grantedBy: [] }] }));
    expect(await executeCli(["api-keys", "doctor"], failing.runtime)).toBe(1);
    expect(failing.stdout()).toContain("✗ API-key storage has a plaintext token column");
    expect(failing.stdout()).toContain("✗ Worker code passes Authorization header values to log calls");
    expect(failing.stdout()).toContain("✗ non-application permissions allow api_key principals");
  });
});

describe("access generators", () => {
  it("validates planes, prefixes, and machine principals", () => {
    expect(permissionEntry({ code: "transactions.review", plane: "application", principals: ["user", "api_key"] }).line).toBe('  "transactions.review": { plane: "application", description: "Review transactions", principals: ["user", "api_key"] },');
    expect(() => permissionEntry({ code: "organization.x", plane: "application" })).toThrow("must declare --plane organization");
    expect(() => permissionEntry({ code: "reports.read", plane: "platform" })).toThrow("must use the platform. prefix");
    expect(() => permissionEntry({ code: "platform.reports.read", plane: "platform", principals: ["api_key"] })).toThrow("remove api_key");
    expect(() => permissionEntry({ code: "Bad", plane: "application" })).toThrow("lowercase dotted");
  });

  it("inserts a permission beside its plane and refuses duplicates", async () => {
    const root = await project();
    const result = await generatePermission(root, await loadProjectManifest(root), { code: "compliance.approve", plane: "application", entitlement: "workflows.advanced" });
    expect(result).toMatchObject({ code: "compliance.approve", plane: "application" });
    const source = await readFile(path.join(root, "packages/authz/src/permissions.ts"), "utf8");
    expect(source.indexOf('"compliance.approve"')).toBeGreaterThan(source.indexOf('"workflows.publish"'));
    expect(source.indexOf('"compliance.approve"')).toBeLessThan(source.indexOf('"platform.overview.read"'));
    await expect(generatePermission(root, await loadProjectManifest(root), { code: "compliance.approve", plane: "application" })).rejects.toThrow("already registered");
    await expect(generatePermission(root, await loadProjectManifest(root), { code: "x.y", plane: "application", entitlement: "made.up" })).rejects.toThrow("not a defined feature");
    const output = capture(root);
    expect(await executeCli(["generate", "permission", "reports.export"], output.runtime)).toBe(1);
  });

  it("generates admin views that require a registered platform permission and never overwrite", async () => {
    const root = await project();
    const output = capture(root);
    expect(await executeCli(["generate", "admin-view", "Contracts", "--group", "Customers", "--permission", "platform.organizations.read"], output.runtime)).toBe(0);
    const descriptor = await readFile(path.join(root, "apps/admin/src/views/contracts/admin-view.ts"), "utf8");
    expect(descriptor).toContain('permission: "platform.organizations.read"');
    expect(descriptor).toContain('group: "Customers"');
    expect(descriptor).toContain('{ id: "contracts.open", label: "Go to Contracts" }');
    expect(descriptor).toContain('import { SquaresFourIcon } from "@phosphor-icons/react";');
    expect(descriptor).toContain("icon: SquaresFourIcon");
    const view = await readFile(path.join(root, "apps/admin/src/views/contracts/view.tsx"), "utf8");
    expect(view).toContain('from "../../shell/ui"');
    expect(view).not.toMatch(/slate-|text-red-/u);
    expect(await executeCli(["generate", "admin-view", "Ledgers", "--icon", "not-an-icon"], capture(root).runtime)).toBe(1);
    expect(await executeCli(["generate", "admin-view", "Contracts"], capture(root).runtime)).toBe(1);
    expect(await executeCli(["generate", "admin-view", "Reports", "--permission", "resource.read"], capture(root).runtime)).toBe(1);
    expect(await executeCli(["generate", "admin-view", "Reports", "--group", "Nowhere"], capture(root).runtime)).toBe(1);
  });
});

describe("admin install", () => {
  it("declares the admin surface idempotently and preserves manifest comments", async () => {
    const root = await project({ admin: false });
    expect(await installAdmin(root, await loadProjectManifest(root))).toEqual({ changed: true, adminPath: "apps/admin" });
    const source = await readFile(path.join(root, ".trestle/project.yaml"), "utf8");
    expect(source).toContain("# keep this comment");
    expect((await loadProjectManifest(root))).toMatchObject({ capabilities: { admin: true }, apps: { admin: "apps/admin" } });
    expect(await installAdmin(root, await loadProjectManifest(root))).toEqual({ changed: false, adminPath: "apps/admin" });
  });

  it("refuses to declare the admin surface without its scaffold", async () => {
    const root = await project({ admin: false, scaffold: false });
    const output = capture(root);
    expect(await executeCli(["admin", "install"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("the admin scaffold is missing");
  });
});

describe("application-owned admin views across SetupPlan apply", () => {
  it("retains a customized admin view, its navigation, and its permission unchanged", async () => {
    const root = await project();
    const output = capture(root);
    expect(await executeCli(["generate", "admin-view", "Contracts", "--group", "Customers", "--permission", "platform.organizations.read"], output.runtime)).toBe(0);
    const viewFile = path.join(root, "apps/admin/src/views/contracts/view.tsx");
    const descriptorFile = path.join(root, "apps/admin/src/views/contracts/admin-view.ts");
    const customized = "export default function Contracts() { return <p>Customized by the application</p>; }\n";
    await writeFile(viewFile, customized);
    const descriptor = await readFile(descriptorFile, "utf8");
    expect(descriptor).toMatch(/group: "Customers"/u);
    expect(descriptor).toMatch(/permission: "platform\.organizations\.read"/u);
    const { planFromManifest } = await import("../src/plan.js");
    const plan = planFromManifest(await loadProjectManifest(root));
    await writeFile(path.join(root, ".trestle/setup.json"), `${JSON.stringify(plan, null, 2)}\n`);
    const applied = capture(root);
    const status = await executeCli(["apply", ".trestle/setup.json", "--yes"], applied.runtime);
    expect([0, 1]).toContain(status);
    expect(await readFile(viewFile, "utf8")).toBe(customized);
    expect(await readFile(descriptorFile, "utf8")).toBe(descriptor);
    // Re-declaring the admin surface and re-generating never touch an existing view either.
    expect(await executeCli(["admin", "install"], capture(root).runtime)).toBe(0);
    expect(await executeCli(["generate", "admin-view", "Contracts"], capture(root).runtime)).toBe(1);
    expect(await readFile(viewFile, "utf8")).toBe(customized);
    expect(await readFile(descriptorFile, "utf8")).toBe(descriptor);
  });
});
