import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectManifest, SetupResource } from "./core.js";

import { exists, generateResourceMigration, names, type ResourceNames } from "./generate-resource.js";
import { registerPlatformPermission, withAdminRouteRegistration } from "./generate-shared-resource.js";
import { CliFailure } from "./runtime.js";

export function adminReadPermission(resource: ResourceNames): string {
  return `platform.${resource.pluralKebab.replaceAll("-", "_")}.read`;
}

type Declaration = SetupResource & { schemaVersion: number; adminAccess?: { read?: boolean }; files?: string[]; registrations?: string[]; routes?: Array<Record<string, unknown>> };

/**
 * Explicitly grants the platform admin read access to a tenant resource across
 * organizations: a platform permission, an RLS select policy and SELECT grant
 * for trestle_platform (never writes), audited detail reads, and an admin
 * list/detail view. Tenant RLS for the application role is unchanged; changes
 * to tenant data stay in the customer application's own semantics.
 */
export async function enableAdminRead(root: string, manifest: ProjectManifest, resourceName: string): Promise<string[]> {
  const n = names(resourceName);
  if (!manifest.capabilities.admin || !manifest.apps.admin) throw new CliFailure("enable the platform admin with a reviewed SetupPlan before granting it read access to a resource");
  const declarationPath = path.join(root, ".trestle", "resources", `${n.kebab}.json`);
  const declaration = JSON.parse(await readFile(declarationPath, "utf8").catch(() => { throw new CliFailure(`resource ${resourceName} is not declared in .trestle/resources`); })) as Declaration;
  if (declaration.tenant === false) throw new CliFailure(`${resourceName} is shared; its platform editor already reads it`);
  if (declaration.schemaVersion !== 2) throw new CliFailure(`resource ${resourceName} must be regenerated with a version 2 declaration first`);
  if (declaration.adminAccess?.read) throw new CliFailure(`${resourceName} already grants the platform admin read access`);
  const dbPath = manifest.packages.db ?? "packages/db";
  const project = manifest.project.name;
  const permission = adminReadPermission(n);
  const schemaPath = path.join(root, dbPath, "src", `${n.kebab}-schema.ts`);
  const schema = await readFile(schemaPath, "utf8");
  const policyAnchor = `  pgPolicy("${n.snake}_tenant", {`;
  if (!schema.includes(policyAnchor)) throw new CliFailure(`${path.relative(root, schemaPath)} does not contain the managed tenant policy anchor`);
  const admin = {
    module: path.join(root, dbPath, "src", `${n.kebab}-platform.ts`),
    moduleTest: path.join(root, dbPath, "src", `${n.kebab}-platform.integration.test.ts`),
    routes: path.join(root, manifest.apps.admin, "worker", "resources", `${n.kebab}.ts`),
    routesTest: path.join(root, manifest.apps.admin, "worker", "resources", `${n.kebab}.test.ts`),
    worker: path.join(root, manifest.apps.admin, "worker", "index.ts"),
    registry: path.join(root, manifest.apps.admin, "src", "application-views.ts"),
    descriptor: path.join(root, manifest.apps.admin, "src", "views", n.pluralKebab, "admin-view.ts"),
    view: path.join(root, manifest.apps.admin, "src", "views", n.pluralKebab, "view.tsx"),
  };
  const generated = [admin.module, admin.moduleTest, admin.routes, admin.routesTest, admin.descriptor, admin.view];
  const collisions = (await Promise.all(generated.map(async (file) => (await exists(file) ? file : undefined)))).filter(Boolean);
  if (collisions.length) throw new CliFailure(`admin read access for ${resourceName} collides with existing files: ${collisions.join(", ")}`);
  const workerSource = await readFile(admin.worker, "utf8");
  if (workerSource.split("// trestle:admin-resource-routes").length !== 2) throw new CliFailure(`${path.relative(root, admin.worker)} has no unique // trestle:admin-resource-routes anchor; run trestle upgrade first`);
  const registrySource = await readFile(admin.registry, "utf8");
  if (registrySource.split("  // trestle:admin-module-list").length !== 2) throw new CliFailure("admin application view registry has no unique generation anchor; review it manually");

  const changed: string[] = [];
  const registryPath = path.join(root, manifest.packages.authz ?? "packages/authz", "src", "permissions.ts");
  if (await registerPlatformPermission(registryPath, permission, `Read ${n.className} records across organizations in the platform admin`)) changed.push(path.relative(root, registryPath));
  await writeFile(schemaPath, schema.replace(policyAnchor, `  // Explicit platform read access (trestle resource admin-read): select only, never writes.\n  pgPolicy("${n.snake}_platform_read", { as: "permissive", for: "select", to: "trestle_platform", using: sql\`true\` }),\n${policyAnchor}`), "utf8");
  changed.push(path.relative(root, schemaPath));
  for (const file of generated) await mkdir(path.dirname(file), { recursive: true });
  const adminPath = `/api/admin/${n.pluralKebab}`;

  await writeFile(admin.module, `import { and, asc, eq, gt } from "drizzle-orm";

import { recordAuditEvent, type AuditActorType } from "./audit.js";
import { ${n.camel} } from "./${n.kebab}-schema.js";
import type { Database } from "./index.js";
import { PlatformOperationError } from "./platform-operations.js";

/**
 * Platform reads of ${n.className} across organizations on the trestle_platform
 * connection, which may select but never change tenant rows. Opening a record
 * is audited on its organization.
 */
export type ${n.className}PlatformRow = typeof ${n.camel}.$inferSelect;
type ReadContext = Readonly<{ actor: { type: AuditActorType; id: string }; environment: string; correlationId: string }>;

export async function listPlatform${n.className}Records(database: Database, input: Readonly<{ organizationId?: string; cursor?: string; limit?: number }> = {}): Promise<{ items: ${n.className}PlatformRow[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200);
  const rows = await database.select().from(${n.camel})
    .where(and(input.organizationId ? eq(${n.camel}.organizationId, input.organizationId) : undefined, input.cursor ? gt(${n.camel}.id, input.cursor) : undefined))
    .orderBy(asc(${n.camel}.id)).limit(limit + 1);
  const items = rows.slice(0, limit);
  return { items, ...(rows.length > limit && items.at(-1) ? { nextCursor: items.at(-1)!.id } : {}) };
}

export async function readPlatform${n.className}(database: Database, id: string, context: ReadContext): Promise<${n.className}PlatformRow> {
  const [record] = await database.select().from(${n.camel}).where(eq(${n.camel}.id, id)).limit(1);
  if (!record) throw new PlatformOperationError("not_found", "${n.className} not found");
  await recordAuditEvent(database, {
    name: "platform.${n.snake}.viewed", actor: context.actor, organizationId: record.organizationId, target: { type: "${n.snake}", id: record.id },
    environment: context.environment, correlationId: context.correlationId,
  });
  return record;
}
`, "utf8");

  await writeFile(admin.moduleTest, `import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { auditEvent } from "./audit-schema.js";
import { createDatabase } from "./index.js";
import { readPlatform${n.className} } from "./${n.kebab}-platform.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const prefix = \`${n.kebab}-platform-\${Date.now()}-\`;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;

suite("${n.className} platform read access", () => {
  afterAll(async () => { await sql!\`delete from ${n.snake} where name like \${\`\${prefix}%\`}\`; await sql!.end(); });
  it("lets the platform role read every organization's rows and change none", async () => {
    await sql!\`insert into ${n.snake} (organization_id, name) values ('org-a', \${\`\${prefix}a\`}), ('org-b', \${\`\${prefix}b\`})\`;
    await sql!.begin(async (transaction) => {
      await transaction\`set local role trestle_platform\`;
      expect((await transaction\`select organization_id from ${n.snake} where name like \${\`\${prefix}%\`} order by organization_id\`).map((row) => row.organization_id)).toEqual(["org-a", "org-b"]);
    });
    for (const write of [
      (transaction: postgres.TransactionSql) => transaction\`update ${n.snake} set name = \${\`\${prefix}changed\`} where name like \${\`\${prefix}%\`}\`,
      (transaction: postgres.TransactionSql) => transaction\`delete from ${n.snake} where name like \${\`\${prefix}%\`}\`,
      (transaction: postgres.TransactionSql) => transaction\`insert into ${n.snake} (organization_id, name) values ('org-a', \${\`\${prefix}new\`})\`,
    ]) {
      await expect(sql!.begin(async (transaction) => {
        await transaction\`set local role trestle_platform\`;
        await write(transaction);
      })).rejects.toThrow(/permission denied/u);
    }
  });

  it("audits opening a record on its organization", async () => {
    const [row] = await sql!\`insert into ${n.snake} (organization_id, name) values ('org-audit', \${\`\${prefix}audit\`}) returning id\`;
    const database = createDatabase(connectionString!, "postgres-js");
    const correlationId = crypto.randomUUID();
    const record = await readPlatform${n.className}(database, row!.id, { actor: { type: "platform_operator", id: "operator-audit" }, environment: "local", correlationId });
    expect(record.organizationId).toBe("org-audit");
    const events = await database.select({ name: auditEvent.name, organizationId: auditEvent.organizationId }).from(auditEvent).where(eq(auditEvent.correlationId, correlationId));
    expect(events).toEqual([{ name: "platform.${n.snake}.viewed", organizationId: "org-audit" }]);
    await database.delete(auditEvent).where(eq(auditEvent.correlationId, correlationId));
  });
});
`, "utf8");

  const register = `register${n.className}AdminReadRoutes`;
  await writeFile(admin.routes, `import { listPlatform${n.className}Records, readPlatform${n.className} } from "@${project}/db";

import type { admin as adminApp, AdminResourceHelpers } from "../index.js";

/**
 * Platform read access to ${n.className} across organizations. The view registry
 * declares these routes, so the admin Worker enforces ${permission}.
 */
export function ${register}(admin: typeof adminApp, helpers: AdminResourceHelpers): void {
  admin.get("${adminPath}", async (context) => {
    const organizationId = context.req.query("organizationId");
    const cursor = context.req.query("cursor");
    return context.json(await listPlatform${n.className}Records(helpers.platformDatabase(context.env), { ...(organizationId ? { organizationId } : {}), ...(cursor ? { cursor } : {}) }));
  });
  admin.get("${adminPath}/:id", async (context) => {
    const operator = context.get("operator");
    return context.json({ record: await readPlatform${n.className}(helpers.platformDatabase(context.env), context.req.param("id"), { actor: { type: "platform_operator", id: operator.id }, environment: context.env.APP_ENV ?? "production", correlationId: context.get("correlationId") }) });
  });
}
`, "utf8");

  await writeFile(admin.routesTest, `import { describe, expect, it } from "vitest";

import { admin, adminDependencies, type AdminEnvironment } from "../index.js";
import { adminRoutePolicies } from "../route-policies.js";

const environment: AdminEnvironment = { DATABASE_URL: "postgres://user:password@127.0.0.1:1/unused", DATABASE_DRIVER: "postgres-js", BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" };

describe("${n.className} platform read access", () => {
  it("declares ${permission} and no write routes", () => {
    expect(adminRoutePolicies.filter((policy) => policy.path.startsWith("${adminPath}")).map((policy) => [policy.method, policy.path, policy.permission])).toEqual([
      ["GET", "${adminPath}", "${permission}"],
      ["GET", "${adminPath}/:id", "${permission}"],
    ]);
  });

  it("refuses operators whose platform roles lack ${permission}", async () => {
    adminDependencies.session = async () => ({ user: { id: "operator-1", email: "operator-1@example.test" }, session: { id: "session-1" } });
    adminDependencies.platformRoles = async () => ["platform_operator", "commercial_admin", "security_admin"];
    adminDependencies.assurance = async () => ({ sessionId: "session-1", userId: "operator-1", level: "password", method: "password", verifiedAt: new Date() });
    adminDependencies.enrolledFactor = async () => null;
    for (const route of ["${adminPath}", "${adminPath}/00000000-0000-4000-8000-000000000001"]) {
      const response = await admin.request(route, {}, environment);
      expect({ route, status: response.status, body: await response.json() }).toMatchObject({ route, status: 403, body: { reason: "permission_missing" } });
    }
  });
});
`, "utf8");

  await writeFile(admin.worker, withAdminRouteRegistration(workerSource, `import { ${register} } from "./resources/${n.kebab}.js";`, `${register}(admin, adminResourceHelpers);`, path.relative(root, admin.worker)), "utf8");
  const label = `${n.className} records`;
  const entry = `  { id: "${n.pluralKebab}", path: "/records/${n.pluralKebab}", label: "${label}", group: "Customers", permission: "${permission}", api: [{ method: "GET", path: "${adminPath}" }, { method: "GET", path: "${adminPath}/:id" }] },\n`;
  await writeFile(admin.registry, registrySource.replace("  // trestle:admin-module-list", `${entry}  // trestle:admin-module-list`), "utf8");
  await writeFile(admin.descriptor, `import { TableIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "${n.pluralKebab}",
  path: "/records/${n.pluralKebab}",
  navigation: { label: "${label}", group: "Customers", order: 900, icon: TableIcon },
  permission: "${permission}",
  component: () => import("./view"),
  commands: [{ id: "${n.pluralKebab}.open", label: "Go to ${label}" }],
});
`, "utf8");
  const fields = declaration.fields.map((field) => field.name);
  await writeFile(admin.view, `import { useState } from "react";

import { api } from "../../api";
import { useAdminQuery } from "../../shell/context";
import { Button, Input } from "../../shell/kumo";
import { AdminDetailDrawer, AdminFacts, useSelectedDetail } from "../../shell/resource";
import { AdminDataTable, AdminPageHeader, AdminQueryState, AdminSection, formatDate } from "../../shell/ui";

type Row = { id: string; organizationId: string; revision: number; createdAt: string; updatedAt: string } & Record<string, unknown>;
const fields = ${JSON.stringify(fields)} as const;
const display = (value: unknown) => value === null || value === undefined ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);

/** ${n.className} records across organizations, read-only. Opening a record is audited on its organization. */
export default function ${n.className}RecordsView() {
  const [organizationId, setOrganizationId] = useState("");
  const [pages, setPages] = useState<string[]>([]);
  const cursor = pages.at(-1);
  const records = useAdminQuery(["${n.pluralKebab}", organizationId, cursor ?? ""], () => api.request<{ items: Row[]; nextCursor?: string }>("GET", "${n.pluralKebab}", undefined, { organizationId: organizationId || undefined, cursor }));
  const detail = useSelectedDetail(records.data?.items, (row) => row.id);
  const record = useAdminQuery(["${n.pluralKebab}", "detail", detail.id ?? ""], () => detail.id ? api.request<{ record: Row }>("GET", \`${n.pluralKebab}/\${encodeURIComponent(detail.id)}\`) : Promise.resolve(null));
  return <>
    <AdminPageHeader title="${label}" description="Read-only across organizations. Opening a record is audited." />
    <AdminSection title="Records" actions={<Input aria-label="Organization ID" placeholder="Filter by organization ID" value={organizationId} onChange={(event) => { setOrganizationId(event.target.value.trim()); setPages([]); }} />}>
      <AdminQueryState query={records} isEmpty={(data) => data.items.length === 0} empty="No ${n.pluralKebab}.">{(data) => <>
        <AdminDataTable caption="${label}" rows={data.items} rowKey={(row) => row.id} rowLabel={(row) => display(row.name)} rowActions={(row) => [{ label: "Inspect", run: () => detail.select(row.id) }]}
          columns={[
            { header: "Name", cell: (row) => display(row.name) },
            { header: "Organization", cell: (row) => row.organizationId },
            { header: "Updated", cell: (row) => formatDate(row.updatedAt) },
          ]} />
        <div className="mt-3 flex gap-2">
          {pages.length > 0 && <Button onClick={() => setPages(pages.slice(0, -1))}>Previous</Button>}
          {data.nextCursor && <Button onClick={() => setPages([...pages, data.nextCursor!])}>Next</Button>}
        </div>
      </>}</AdminQueryState>
    </AdminSection>
    <AdminDetailDrawer title={detail.row ? display(detail.row.name) : "${n.className}"} subtitle={detail.row?.organizationId} open={detail.open} onClose={detail.close}>
      {record.data && <AdminFacts items={[...fields.map((name) => [name, display(record.data!.record[name])] as const), ["Revision", record.data.record.revision], ["Created", formatDate(record.data.record.createdAt)], ["Updated", formatDate(record.data.record.updatedAt)], ["ID", record.data.record.id]]} />}
    </AdminDetailDrawer>
  </>;
}
`, "utf8");
  const dbIndex = path.join(root, dbPath, "src", "index.ts");
  const exportLine = `export * from "./${n.kebab}-platform.js";`;
  const indexSource = await readFile(dbIndex, "utf8");
  if (!indexSource.includes(exportLine)) await writeFile(dbIndex, `${indexSource.trimEnd()}\n${exportLine}\n`, "utf8");
  changed.push(...generated.map((file) => path.relative(root, file)), path.relative(root, admin.worker), path.relative(root, admin.registry), path.relative(root, dbIndex));

  const next: Declaration = {
    ...declaration,
    adminAccess: { read: true },
    files: [...(declaration.files ?? []), ...generated.map((file) => path.relative(root, file))],
    registrations: [...new Set([...(declaration.registrations ?? []), path.relative(root, admin.worker), path.relative(root, admin.registry)])],
  };
  await writeFile(declarationPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  changed.push(path.relative(root, declarationPath));
  changed.push(...await generateResourceMigration(root, manifest, [next]));
  return changed;
}
