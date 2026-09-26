import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectManifest, SetupResource } from "./core.js";

import {
  appendExport, assertRelationTargets, columnExpression, ensureJsonValueType, exampleExpression, exists, fieldCheckExpression, jsonValueImport, names,
  pgCoreImports, registerApiOperations, resourceApiOperationsSource, sharedRelationKeyExpression, zodExpression, type ResourceNames,
} from "./generate-resource.js";
import { CliFailure } from "./runtime.js";

/** The platform permission that alone may change a shared resource, e.g. platform.crops.manage. */
export function sharedEditorPermission(resource: ResourceNames): string {
  return `platform.${resource.pluralKebab.replaceAll("-", "_")}.manage`;
}

/** Registers a platform-plane permission in the reviewed permission registry. */
export async function registerPlatformPermission(registryPath: string, permission: string, description: string): Promise<boolean> {
  const source = await readFile(registryPath, "utf8").catch(() => undefined);
  if (source === undefined) throw new CliFailure(`platform access registers ${permission} in packages/authz/src/permissions.ts, which this project does not have; upgrade to the permission registry first`);
  if (source.includes(`"${permission}":`)) {
    if (!source.includes(`"${permission}": { plane: "platform"`)) throw new CliFailure(`${permission} is registered outside the platform plane; platform access requires platform authority`);
    return false;
  }
  const anchor = /\n\}\);/u;
  if (!source.includes("definePermissions({") || !anchor.test(source)) throw new CliFailure("the permission registry has no definePermissions({ ... }); list to extend; add the permission by hand");
  await writeFile(registryPath, source.replace(anchor, `\n  "${permission}": { plane: "platform", description: "${description}" },\n});`), "utf8");
  return true;
}

/**
 * Generates a shared (non-tenant) resource: reference data such as a catalog that every tenant reads
 * and only platform editors change. The table has no organization_id; forced RLS lets the tenant
 * runtime role read every row and nothing else, and only trestle_platform (the admin Worker's
 * connection) may write, under a registered platform permission, a reason, step-up, and audit.
 */
export async function generateSharedResource(root: string, manifest: ProjectManifest, resource: SetupResource): Promise<string[]> {
  const contextSource = await readFile(path.join(root, manifest.packages.context ?? "packages/context", "src", "index.ts"), "utf8").catch(() => undefined);
  if (contextSource && !/export const AUTHORITY_MODEL_VERSION\s*=\s*(?:[3-9]|\d{2,})\s*;/u.test(contextSource)) {
    throw new CliFailure("resource generation requires independent application authority; migrate to the permission-registry ExecutionContext (authority model 3) before generating new routes");
  }
  if (resource.webhookEvents.length) throw new CliFailure("shared resources do not emit tenant webhooks; remove --webhook-event");
  const n = names(resource.name);
  const project = manifest.project.name;
  const contractsPath = manifest.packages.contracts ?? "packages/contracts";
  const domainPath = manifest.packages.domain ?? "packages/domain";
  const dataPath = manifest.packages.data ?? "packages/data";
  const dbPath = manifest.packages.db ?? "packages/db";
  const workerPath = manifest.apps.worker ?? "apps/worker";
  const appPath = manifest.apps.app ?? "apps/app";
  const permission = sharedEditorPermission(n);
  const readPermission = resource.authorization?.read ?? "resource.read";
  if (resource.authorization?.write && resource.authorization.write !== permission) throw new CliFailure(`shared resource ${resource.name} is written only with ${permission}; do not set a write permission`);
  const declarationPath = path.join(root, ".trestle", "resources", `${n.kebab}.json`);
  const targets = {
    contracts: path.join(root, contractsPath, "src", "resources", `${n.kebab}.ts`),
    domain: path.join(root, domainPath, "src", "resources", `${n.kebab}.ts`),
    repository: path.join(root, dataPath, "src", "resources", `${n.kebab}-repository.ts`),
    schema: path.join(root, dbPath, "src", `${n.kebab}-schema.ts`),
    routes: path.join(root, workerPath, "src", "resources", `${n.kebab}-routes.ts`),
    screen: path.join(root, appPath, "src", "resources", `${n.kebab}.tsx`),
    contractsTest: path.join(root, contractsPath, "src", "resources", `${n.kebab}.test.ts`),
    rlsTest: path.join(root, dbPath, "src", `${n.kebab}-rls.integration.test.ts`),
    client: path.join(root, appPath, "src", "api", `${n.kebab}.ts`),
    editor: path.join(root, dbPath, "src", `${n.kebab}-editor.ts`),
    editorTest: path.join(root, dbPath, "src", `${n.kebab}-editor.integration.test.ts`),
  };
  const admin = manifest.capabilities.admin && manifest.apps.admin ? {
    routes: path.join(root, manifest.apps.admin, "worker", "resources", `${n.kebab}.ts`),
    routesTest: path.join(root, manifest.apps.admin, "worker", "resources", `${n.kebab}.test.ts`),
    worker: path.join(root, manifest.apps.admin, "worker", "index.ts"),
    registry: path.join(root, manifest.apps.admin, "src", "application-views.ts"),
    descriptor: path.join(root, manifest.apps.admin, "src", "views", n.pluralKebab, "admin-view.ts"),
    view: path.join(root, manifest.apps.admin, "src", "views", n.pluralKebab, "view.tsx"),
  } : undefined;
  const all = [...Object.values(targets), ...(admin ? [admin.routes, admin.routesTest, admin.descriptor, admin.view] : [])];
  const declarationExists = await exists(declarationPath);
  const collisions = (await Promise.all(all.map(async (target) => (await exists(target) ? target : undefined)))).filter((target): target is string => Boolean(target));
  if (collisions.length && !declarationExists) throw new CliFailure(`resource ${resource.name} collides with existing files: ${collisions.join(", ")}`);
  const intended = { fields: resource.fields, authorization: { read: readPermission, write: permission }, pagination: resource.pagination };
  if (declarationExists) {
    const current = JSON.parse(await readFile(declarationPath, "utf8")) as { name?: string; tenant?: boolean; fields?: unknown; authorization?: unknown; pagination?: unknown };
    if (current.name !== resource.name || current.tenant !== false || JSON.stringify({ fields: current.fields, authorization: current.authorization, pagination: current.pagination }) !== JSON.stringify(intended)) {
      throw new CliFailure(`resource ${resource.name} already exists with a different declaration`);
    }
  }
  await assertRelationTargets(root, dbPath, resource.name, resource.fields, false);
  let adminWorkerSource: string | undefined;
  let adminRegistrySource: string | undefined;
  if (admin) {
    adminWorkerSource = await readFile(admin.worker, "utf8");
    if (adminWorkerSource.split("// trestle:admin-resource-routes").length !== 2) throw new CliFailure(`${path.relative(root, admin.worker)} has no unique // trestle:admin-resource-routes anchor; run trestle upgrade, or register the shared resource's admin routes by hand`);
    adminRegistrySource = await readFile(admin.registry, "utf8");
    if (adminRegistrySource.split("  // trestle:admin-module-list").length !== 2) throw new CliFailure("admin application view registry has no unique generation anchor; review it manually");
  }
  const registryPath = path.join(root, manifest.packages.authz ?? "packages/authz", "src", "permissions.ts");
  const created: string[] = [];
  if (await registerPlatformPermission(registryPath, permission, `Create, update, and delete shared ${n.className} records`)) created.push(path.relative(root, registryPath));
  for (const target of all) await mkdir(path.dirname(target), { recursive: true });
  const writeGenerated = async (target: string, source: string) => {
    if (await exists(target)) return;
    await writeFile(target, source, "utf8");
    created.push(path.relative(root, target));
  };

  const routePath = `/api/${n.pluralKebab}`;
  const adminPath = `/api/admin/${n.pluralKebab}`;
  await mkdir(path.dirname(declarationPath), { recursive: true });
  await writeFile(declarationPath, `${JSON.stringify({
    schemaVersion: 2,
    name: resource.name,
    tenant: false,
    crud: resource.crud,
    webhookEvents: [],
    ...intended,
    persistence: { table: n.snake, schema: path.relative(root, targets.schema) },
    contracts: path.relative(root, targets.contracts),
    files: [targets.contracts, targets.domain, targets.repository, targets.schema, targets.routes, targets.screen, targets.contractsTest, targets.rlsTest, targets.client, targets.editor, targets.editorTest, ...(admin ? [admin.routes, admin.routesTest, admin.descriptor, admin.view] : [])].map((target) => path.relative(root, target)),
    registrations: [path.join(workerPath, "src", "index.ts"), path.join(appPath, "src", "main.tsx"), ...(admin ? [path.relative(root, admin.worker), path.relative(root, admin.registry)] : [])],
    routes: [
      { method: "GET", path: routePath, auth: true },
      { method: "GET", path: `${routePath}/:id`, auth: true },
      ...(admin ? ["GET", "POST", "PATCH", "DELETE"].map((method) => ({ method, path: method === "GET" || method === "POST" ? adminPath : `${adminPath}/:id`, auth: true, permission: method === "GET" ? undefined : permission })) : []),
    ],
  }, null, 2)}\n`, "utf8");
  if (!declarationExists) created.push(path.relative(root, declarationPath));

  await writeGenerated(targets.contracts, `import { z } from "zod";

import type { ApiOperation } from "../api.js";

/** Values an editor supplies; shared ${n.className} records are changed only through the platform admin. */
export const ${n.camel}ValuesSchema = z.object({
${resource.fields.map((field) => `  ${field.name}: ${zodExpression(field)},`).join("\n")}
});
export const ${n.camel}Schema = z.object({
${resource.fields.map((field) => `  ${field.name}: ${field.required ? zodExpression(field) : `${zodExpression({ ...field, required: true })}.nullable()`},`).join("\n")}
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ${n.className} = z.infer<typeof ${n.camel}Schema>;
export type ${n.className}Values = z.infer<typeof ${n.camel}ValuesSchema>;
${resourceApiOperationsSource(n, routePath, { read: readPermission }, n.pluralKebab)}`);
  await writeGenerated(targets.contractsTest, `import { describe, expect, it } from "vitest";
import { ${n.camel}ValuesSchema } from "./${n.kebab}.js";

describe("${n.className} contracts", () => {
  it("validates shared values", () => {
    const valid = { ${resource.fields.filter(({ required }) => required).map((field) => `${field.name}: ${exampleExpression(field)}`).join(", ")} };
    expect(${n.camel}ValuesSchema.parse(valid)).toMatchObject(valid);
    expect(() => ${n.camel}ValuesSchema.parse({ name: "" })).toThrow();
  });
});
`);

  await writeGenerated(targets.domain, `import type { ${n.className} } from "@${project}/contracts";

/** Shared ${n.className} records are read-only to tenants; platform editors change them in the admin. */
export interface ${n.className}Repository {
  list(input: { cursor?: string; limit: number }): Promise<{ items: ${n.className}[]; nextCursor?: string }>;
  get(id: string): Promise<${n.className} | null>;
}

export class ${n.className}Service {
  constructor(private readonly repository: ${n.className}Repository) {}
  list(input: { cursor?: string; limit: number }) { return this.repository.list(input); }
  get(id: string) { return this.repository.get(id); }
}
`);

  await writeGenerated(targets.repository, `import type { ${n.className} } from "@${project}/contracts";
import { ${n.camel}, type Database } from "@${project}/db";
import type { ${n.className}Repository } from "@${project}/domain";
import { asc, eq, gt } from "drizzle-orm";

/** Reads shared rows on the tenant runtime connection, where forced RLS allows select only. */
export class Postgres${n.className}Repository implements ${n.className}Repository {
  constructor(private readonly database: Database) {}
  async list(input: { cursor?: string; limit: number }): Promise<{ items: ${n.className}[]; nextCursor?: string }> {
    const rows = await this.database.select().from(${n.camel}).where(input.cursor ? gt(${n.camel}.id, input.cursor) : undefined).orderBy(asc(${n.camel}.id)).limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    return { items, ...(hasMore && items.at(-1) ? { nextCursor: items.at(-1)!.id } : {}) };
  }
  async get(id: string): Promise<${n.className} | null> {
    const [record] = await this.database.select().from(${n.camel}).where(eq(${n.camel}.id, id)).limit(1);
    return record ?? null;
  }
}
`);

  const relations = resource.fields.filter((field) => field.type === "relation");
  const hasJson = resource.fields.some((field) => field.type === "json");
  if (hasJson) {
    const jsonValue = await ensureJsonValueType(path.dirname(targets.schema));
    if (jsonValue) created.push(path.relative(root, jsonValue));
  }
  await writeGenerated(targets.schema, `import { sql } from "drizzle-orm";
import { ${["boolean", ...(relations.length ? ["foreignKey"] : []), "integer", "pgPolicy", "pgTable", "text", "timestamp", "uuid", ...pgCoreImports(resource.fields)].sort((a, b) => a.localeCompare(b)).join(", ")} } from "drizzle-orm/pg-core";
${hasJson ? `${jsonValueImport}\n` : ""}${[...new Set(relations.map((field) => field.references!.resource))].map((related) => `import { ${names(related).camel} } from "./${names(related).kebab}-schema.js";`).join("\n")}

/**
 * Shared (non-tenant) ${n.className} records. Every tenant runtime may read them; only the
 * trestle_platform role may write, and the admin Worker requires ${permission} to do so.
 */
export const ${n.camel} = pgTable("${n.snake}", {
  id: uuid("id").defaultRandom().primaryKey(),
${resource.fields.map((field) => `  ${field.name}: ${columnExpression(field)},`).join("\n")}
  revision: integer("revision").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
${relations.map((field) => `${sharedRelationKeyExpression(n, field)}\n`).join("")}${resource.fields.map((field) => fieldCheckExpression(n, field)).filter(Boolean).map((line) => `${line}\n`).join("")}  pgPolicy("${n.snake}_tenant_read", { as: "permissive", for: "select", to: "trestle_app", using: sql\`true\` }),
  pgPolicy("${n.snake}_platform_manage", { as: "permissive", for: "all", to: "trestle_platform", using: sql\`true\`, withCheck: sql\`true\` }),
]).enableRLS();
`);

  await writeGenerated(targets.editor, `import { and, asc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";

import { recordAuditEvent } from "./audit.js";
import { ${n.camel} } from "./${n.kebab}-schema.js";
import type { Database } from "./index.js";
import { PlatformOperationError } from "./platform-operations.js";
import type { PlatformChangeContext } from "./platform-roles.js";

/**
 * Platform editing for shared ${n.className} records on the trestle_platform connection. Every
 * change carries a reason, is audited in the same transaction, and names the revision it replaces.
 */
const ${n.camel}EditorValues = z.object({
${resource.fields.map((field) => `  ${field.name}: ${zodExpression(field)},`).join("\n")}
}).strict();
export type ${n.className}EditorValues = z.infer<typeof ${n.camel}EditorValues>;
type ${n.className}Row = typeof ${n.camel}.$inferSelect;

function reasonOf(context: PlatformChangeContext): string {
  const text = context.reason.trim();
  if (!text || text.length > 500) throw new PlatformOperationError("invalid", "A reason of at most 500 characters is required");
  return text;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new PlatformOperationError("invalid", result.error.issues.map((issue) => \`\${issue.path.join(".") || "values"}: \${issue.message}\`).join("; "));
  return result.data;
}

const audit = (transaction: Parameters<Parameters<Database["transaction"]>[0]>[0], name: string, record: ${n.className}Row, context: PlatformChangeContext, reason: string, summary: Record<string, unknown>) => recordAuditEvent(transaction, {
  name, actor: context.actor, organizationId: null, target: { type: "${n.snake}", id: record.id }, reason, summary: { ...summary, revision: record.revision },
  environment: context.environment, correlationId: context.correlationId, ...(context.now ? { occurredAt: context.now } : {}),
});

export async function list${n.className}Records(database: Database, input: Readonly<{ cursor?: string; limit?: number }> = {}): Promise<{ items: ${n.className}Row[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 200);
  const rows = await database.select().from(${n.camel}).where(input.cursor ? gt(${n.camel}.id, input.cursor) : undefined).orderBy(asc(${n.camel}.id)).limit(limit + 1);
  const items = rows.slice(0, limit);
  return { items, ...(rows.length > limit && items.at(-1) ? { nextCursor: items.at(-1)!.id } : {}) };
}

export async function create${n.className}(database: Database, values: unknown, context: PlatformChangeContext): Promise<${n.className}Row> {
  const parsed = parse(${n.camel}EditorValues, values);
  const reason = reasonOf(context);
  return await database.transaction(async (transaction) => {
    const [record] = await transaction.insert(${n.camel}).values({ ...parsed, ...(context.now ? { createdAt: context.now, updatedAt: context.now } : {}) }).returning();
    await audit(transaction, "platform.${n.snake}.created", record!, context, reason, { fields: Object.keys(parsed) });
    return record!;
  });
}

async function current(transaction: Parameters<Parameters<Database["transaction"]>[0]>[0], id: string): Promise<${n.className}Row> {
  const [record] = await transaction.select().from(${n.camel}).where(eq(${n.camel}.id, id)).limit(1);
  if (!record) throw new PlatformOperationError("not_found", "${n.className} not found");
  return record;
}

/** Applies the change only if the record is still at expectedRevision; otherwise reports a conflict. */
export async function update${n.className}(database: Database, input: Readonly<{ id: string; values: unknown; expectedRevision: number }>, context: PlatformChangeContext): Promise<${n.className}Row> {
  const parsed = parse(${n.camel}EditorValues.partial().refine((value) => Object.keys(value).length > 0, "at least one field is required"), input.values);
  const reason = reasonOf(context);
  return await database.transaction(async (transaction) => {
    const [record] = await transaction.update(${n.camel})
      .set({ ...parsed, revision: sql\`\${${n.camel}.revision} + 1\`, updatedAt: context.now ?? new Date() })
      .where(and(eq(${n.camel}.id, input.id), eq(${n.camel}.revision, input.expectedRevision))).returning();
    if (!record) {
      const existing = await current(transaction, input.id);
      throw new PlatformOperationError("conflict", \`${n.className} changed since it was loaded (now revision \${existing.revision}); reload and try again\`);
    }
    await audit(transaction, "platform.${n.snake}.updated", record, context, reason, { fields: Object.keys(parsed) });
    return record;
  });
}

export async function delete${n.className}(database: Database, input: Readonly<{ id: string; expectedRevision: number }>, context: PlatformChangeContext): Promise<void> {
  const reason = reasonOf(context);
  await database.transaction(async (transaction) => {
    const [record] = await transaction.delete(${n.camel}).where(and(eq(${n.camel}.id, input.id), eq(${n.camel}.revision, input.expectedRevision))).returning();
    if (!record) {
      const existing = await current(transaction, input.id);
      throw new PlatformOperationError("conflict", \`${n.className} changed since it was loaded (now revision \${existing.revision}); reload and try again\`);
    }
    await audit(transaction, "platform.${n.snake}.deleted", record, context, reason, {});
  });
}
`);

  await writeGenerated(targets.rlsTest, `import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const prefix = \`${n.kebab}-shared-\${Date.now()}-\`;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;

suite("${n.className} shared read and platform-only writes", () => {
  beforeAll(async () => { await sql!\`insert into ${n.snake} (name) values (\${\`\${prefix}row\`})\`; });
  afterAll(async () => { await sql!\`delete from ${n.snake} where name like \${\`\${prefix}%\`}\`; await sql!.end(); });
  it("is readable by every tenant and writable by none", async () => {
    for (const organization of ["org-a", "org-b"]) {
      await sql!.begin(async (transaction) => {
        await transaction\`set local role trestle_app\`;
        await transaction\`select set_config('app.organization_id', \${organization}, true)\`;
        expect(await transaction\`select id from ${n.snake} where name like \${\`\${prefix}%\`}\`).toHaveLength(1);
      });
    }
    for (const write of [
      (transaction: postgres.TransactionSql) => transaction\`insert into ${n.snake} (name) values (\${\`\${prefix}tenant\`})\`,
      (transaction: postgres.TransactionSql) => transaction\`update ${n.snake} set name = \${\`\${prefix}changed\`} where name like \${\`\${prefix}%\`}\`,
      (transaction: postgres.TransactionSql) => transaction\`delete from ${n.snake} where name like \${\`\${prefix}%\`}\`,
    ]) {
      await expect(sql!.begin(async (transaction) => {
        await transaction\`set local role trestle_app\`;
        await transaction\`select set_config('app.organization_id', 'org-a', true)\`;
        await write(transaction);
      })).rejects.toThrow(/permission denied/u);
    }
  });
  it("lets only the platform role write", async () => {
    await sql!.begin(async (transaction) => {
      await transaction\`set local role trestle_platform\`;
      await transaction\`update ${n.snake} set revision = revision + 1 where name like \${\`\${prefix}%\`}\`;
      expect((await transaction\`select revision from ${n.snake} where name like \${\`\${prefix}%\`}\`)[0]).toMatchObject({ revision: 2 });
    });
  });
});
`);

  await writeGenerated(targets.editorTest, `import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditEvent } from "./audit-schema.js";
import { create${n.className}, delete${n.className}, update${n.className} } from "./${n.kebab}-editor.js";
import { createDatabase } from "./index.js";
import { PlatformOperationError } from "./platform-operations.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite("${n.className} platform editor", () => {
  it("audits each change and rejects stale revisions", async () => {
    const database = createDatabase(connectionString!, "postgres-js");
    const context = { actor: { type: "platform_operator" as const, id: "editor-" + crypto.randomUUID() }, reason: "Catalog correction", environment: "local", correlationId: crypto.randomUUID() };
    const record = await create${n.className}(database, { name: "Editor original" }, context);
    try {
      const updated = await update${n.className}(database, { id: record.id, values: { name: "Editor changed" }, expectedRevision: 1 }, context);
      expect(updated).toMatchObject({ name: "Editor changed", revision: 2 });
      await expect(update${n.className}(database, { id: record.id, values: { name: "Stale" }, expectedRevision: 1 }, context)).rejects.toMatchObject({ code: "conflict" });
      await expect(delete${n.className}(database, { id: record.id, expectedRevision: 1 }, context)).rejects.toBeInstanceOf(PlatformOperationError);
      await expect(create${n.className}(database, { name: "No reason" }, { ...context, reason: " " })).rejects.toMatchObject({ code: "invalid" });
      await delete${n.className}(database, { id: record.id, expectedRevision: 2 }, context);
      const events = await database.select({ name: auditEvent.name, reason: auditEvent.reason, organizationId: auditEvent.organizationId }).from(auditEvent)
        .where(and(eq(auditEvent.targetId, record.id), eq(auditEvent.actorId, context.actor.id)));
      expect(events.map((event) => event.name).sort()).toEqual(["platform.${n.snake}.created", "platform.${n.snake}.deleted", "platform.${n.snake}.updated"]);
      expect(events.every((event) => event.reason === "Catalog correction" && event.organizationId === null)).toBe(true);
    } finally {
      await database.delete(auditEvent).where(eq(auditEvent.actorId, context.actor.id));
    }
  });
});
`);

  await writeGenerated(targets.routes, `import { type AuthEnvironment } from "@${project}/auth";
import { Postgres${n.className}Repository } from "@${project}/data";
import { ${n.className}Service } from "@${project}/domain";
import { Hono } from "hono";

import { requireExecutionContext, type AppVariables } from "../execution-context.js";

/** Shared ${n.className} records are read-only here; platform editors change them in the admin. */
export const ${n.camel}Routes = new Hono<{ Bindings: AuthEnvironment; Variables: AppVariables }>();
${n.camel}Routes.use("${routePath}", requireExecutionContext);
${n.camel}Routes.use("${routePath}/*", requireExecutionContext);
function service(execution: AppVariables["execution"]) {
  return new ${n.className}Service(new Postgres${n.className}Repository(execution.data));
}
${n.camel}Routes.get("${routePath}", async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "${readPermission}" });
  const cursor = context.req.query("cursor");
  const requestedLimit = Number(context.req.query("limit") ?? "${resource.pagination.defaultLimit}");
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > ${resource.pagination.maxLimit}) return context.json({ error: "validation_failed", message: "limit must be between 1 and ${resource.pagination.maxLimit}" }, 400);
  if (cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(cursor)) return context.json({ error: "validation_failed", message: "cursor must be a UUID" }, 400);
  const page = await service(execution).list({ ...(cursor ? { cursor } : {}), limit: requestedLimit });
  return context.json({ ${n.camel}s: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
});
${n.camel}Routes.get("${routePath}/:id", async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "${readPermission}" });
  const record = await service(execution).get(context.req.param("id"));
  return record ? context.json({ ${n.camel}: record }) : context.json({ error: "Not found" }, 404);
});
`);

  await writeGenerated(targets.client, `import { ${n.camel}Schema, type ${n.className} } from "@${project}/contracts";

const apiOrigin = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\\/$/u, "") ?? "";
async function request<T>(organizationId: string, pathname: string): Promise<T> {
  const response = await fetch(\`\${apiOrigin}\${pathname}\`, { credentials: "include", headers: { "content-type": "application/json", "x-trestle-tenant": organizationId } });
  const body = await response.json();
  if (!response.ok) throw new Error((body as { message?: string; error?: string } | undefined)?.message ?? (body as { error?: string } | undefined)?.error ?? \`Request failed (\${response.status})\`);
  return body as T;
}

/** Shared ${n.className} records are read-only in the customer application. */
export function create${n.className}Api(organizationId: string) {
  return {
    async list(input: { cursor?: string; limit?: number } = {}): Promise<{ items: ${n.className}[]; nextCursor?: string }> {
      const query = new URLSearchParams();
      if (input.cursor) query.set("cursor", input.cursor);
      if (input.limit) query.set("limit", String(input.limit));
      const result = await request<{ ${n.camel}s: unknown[]; nextCursor?: string }>(organizationId, "${routePath}" + (query.size ? "?" + query.toString() : ""));
      return { items: result.${n.camel}s.map((item) => ${n.camel}Schema.parse(item)), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
    },
    async get(id: string): Promise<${n.className}> { const result = await request<{ ${n.camel}: unknown }>(organizationId, \`${routePath}/\${id}\`); return ${n.camel}Schema.parse(result.${n.camel}); },
  };
}
`);

  await writeGenerated(targets.screen, `import { useQuery } from "@tanstack/react-query";

import { authClient } from "../auth-client.js";
import { create${n.className}Api } from "../api/${n.kebab}.js";

/** Shared ${n.className} records, read-only here; platform editors change them in the admin. */
export function ${n.className}Screen() {
  const { data: session } = authClient.useSession();
  const activeOrganization = authClient.useActiveOrganization();
  const organizationId = activeOrganization.data?.id;
  const query = useQuery({
    queryKey: ["${n.pluralKebab}", session?.user.id, organizationId],
    enabled: Boolean(session?.user.id && organizationId),
    queryFn: async () => (await create${n.className}Api(organizationId!).list()).items,
  });
  if (!session?.user.id || !organizationId) return <section className="card p-8"><h1 className="text-3xl font-semibold">${n.className}</h1><p className="mt-4 text-slate-600">Sign in and select an organization to browse ${n.pluralKebab}.</p></section>;
  return <section className="card p-8">
    <h1 className="text-3xl font-semibold">${n.className}</h1>
    {query.error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">{query.error.message}</p>}
    {query.isPending ? <p className="mt-6 text-slate-600">Loading…</p> : query.data?.length === 0 ? <p className="mt-6 text-slate-600">No ${n.pluralKebab} yet.</p> : <ul className="mt-6 space-y-2">{query.data?.map((record) => <li className="rounded-xl border p-4" key={record.id}>{record.name}</li>)}</ul>}
  </section>;
}
`);

  await appendExport(path.join(root, contractsPath, "src", "index.ts"), `export * from "./resources/${n.kebab}.js";`);
  const apiRegistry = await registerApiOperations(root, contractsPath, n);
  if (apiRegistry) created.push(apiRegistry);
  await appendExport(path.join(root, domainPath, "src", "index.ts"), `export * from "./resources/${n.kebab}.js";`);
  await appendExport(path.join(root, dataPath, "src", "index.ts"), `export * from "./resources/${n.kebab}-repository.js";`);
  await appendExport(path.join(root, dbPath, "src", "index.ts"), `export * from "./${n.kebab}-schema.js";`);
  await appendExport(path.join(root, dbPath, "src", "index.ts"), `export * from "./${n.kebab}-editor.js";`);

  const workerIndex = path.join(root, workerPath, "src", "index.ts");
  let workerSource = await readFile(workerIndex, "utf8");
  const workerImport = `import { ${n.camel}Routes } from "./resources/${n.kebab}-routes.js";`;
  if (!workerSource.includes(workerImport)) workerSource = `${workerImport}\n${workerSource}`;
  const workerRegistration = `app.route("/", ${n.camel}Routes);`;
  const workerAnchor = ["\nconst consumeQueue =", "\ntype WorkerEnvironment =", "\nexport default {", "\nexport default app;"].find((candidate) => workerSource.includes(candidate));
  if (!workerAnchor) throw new Error("Worker entrypoint has no supported resource registration anchor");
  if (!workerSource.includes(workerRegistration)) workerSource = workerSource.replace(workerAnchor, `\n${workerRegistration}\n${workerAnchor}`);
  await writeFile(workerIndex, workerSource, "utf8");

  const appIndex = path.join(root, appPath, "src", "main.tsx");
  let appSource = await readFile(appIndex, "utf8");
  const appImport = `import { ${n.className}Screen } from "./resources/${n.kebab}.js";`;
  if (!appSource.includes(appImport)) appSource = `${appImport}\n${appSource}`;
  const routeDeclaration = `const ${n.camel}Route = createRoute({ getParentRoute: () => rootRoute, path: "/${n.pluralKebab}", component: ${n.className}Screen });`;
  if (!appSource.includes(routeDeclaration)) appSource = appSource.replace("const routeTree = rootRoute.addChildren([", `${routeDeclaration}\nconst routeTree = rootRoute.addChildren([${n.camel}Route, `);
  const navigationLink = `<Link to="/${n.pluralKebab}" activeProps={{ className: "text-brand-500" }}>${n.className}</Link>`;
  if (!appSource.includes(navigationLink)) appSource = appSource.replace("        {/* trestle:resource-links */}", `        ${navigationLink}\n        {/* trestle:resource-links */}`);
  await writeFile(appIndex, appSource, "utf8");

  if (admin) created.push(...await generateSharedAdmin(root, project, n, resource, permission, admin, adminWorkerSource!, adminRegistrySource!));
  return created;
}

/** Adds a generated admin route module's import and registration call at the admin Worker's anchor. */
export function withAdminRouteRegistration(source: string, importLine: string, call: string, file: string): string {
  let next = source;
  if (!next.includes(importLine)) {
    const lastImport = [...next.matchAll(/^import [^;]*? from "[^"]+";$/gmu)].at(-1);
    if (!lastImport) throw new CliFailure(`${file} has no import statements to extend`);
    const end = lastImport.index + lastImport[0].length;
    next = `${next.slice(0, end)}\n${importLine}${next.slice(end)}`;
  }
  if (!next.includes(call)) next = next.replace("// trestle:admin-resource-routes", `${call}\n// trestle:admin-resource-routes`);
  return next;
}

async function generateSharedAdmin(
  root: string, project: string, n: ResourceNames, resource: SetupResource, permission: string,
  admin: { routes: string; routesTest: string; worker: string; registry: string; descriptor: string; view: string }, workerSource: string, registrySource: string,
): Promise<string[]> {
  const created: string[] = [];
  const adminPath = `/api/admin/${n.pluralKebab}`;
  const register = `register${n.className}AdminRoutes`;
  const writeNew = async (target: string, source: string) => {
    if (await exists(target)) return;
    await writeFile(target, source, "utf8");
    created.push(path.relative(root, target));
  };
  await writeNew(admin.routes, `import { create${n.className}, delete${n.className}, list${n.className}Records, update${n.className} } from "@${project}/db";

import type { admin as adminApp, AdminResourceHelpers } from "../index.js";

type Body = { values?: unknown; expectedRevision?: unknown; reason?: unknown };
const revisionOf = (body: Body): number => {
  const revision = Number(body.expectedRevision);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
};

/**
 * Platform editing for shared ${n.className} records. The view registry (application-views.ts)
 * declares these routes, so the admin Worker enforces ${permission} and fresh step-up before
 * each change; the editor requires a reason and audits in the same transaction.
 */
export function ${register}(admin: typeof adminApp, helpers: AdminResourceHelpers): void {
  admin.get("${adminPath}", async (context) => context.json(await list${n.className}Records(helpers.platformDatabase(context.env), { ...(context.req.query("cursor") ? { cursor: context.req.query("cursor")! } : {}) })));
  admin.post("${adminPath}", async (context) => {
    const body = await context.req.json().catch(() => ({})) as Body;
    return context.json({ record: await create${n.className}(helpers.platformDatabase(context.env), body.values, await helpers.actionContext(context, body)) }, 201);
  });
  admin.patch("${adminPath}/:id", async (context) => {
    const body = await context.req.json().catch(() => ({})) as Body;
    return context.json({ record: await update${n.className}(helpers.platformDatabase(context.env), { id: context.req.param("id"), values: body.values, expectedRevision: revisionOf(body) }, await helpers.actionContext(context, body)) });
  });
  admin.delete("${adminPath}/:id", async (context) => {
    const body = await context.req.json().catch(() => ({})) as Body;
    await delete${n.className}(helpers.platformDatabase(context.env), { id: context.req.param("id"), expectedRevision: revisionOf(body) }, await helpers.actionContext(context, body));
    return context.body(null, 204);
  });
}
`);
  await writeNew(admin.routesTest, `import { describe, expect, it } from "vitest";

import { admin, adminDependencies, type AdminEnvironment } from "../index.js";
import { adminRoutePolicies } from "../route-policies.js";

const environment: AdminEnvironment = { DATABASE_URL: "postgres://user:password@127.0.0.1:1/unused", DATABASE_DRIVER: "postgres-js", BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" };

describe("${n.className} platform editing", () => {
  it("declares ${permission} on every editing route", () => {
    for (const [method, route] of [["GET", "${adminPath}"], ["POST", "${adminPath}"], ["PATCH", "${adminPath}/:id"], ["DELETE", "${adminPath}/:id"]] as const) {
      expect(adminRoutePolicies.find((policy) => policy.method === method && policy.path === route)).toMatchObject({ permission: "${permission}" });
    }
  });

  it("refuses operators whose platform roles lack ${permission}", async () => {
    adminDependencies.session = async () => ({ user: { id: "operator-1", email: "operator-1@example.test" }, session: { id: "session-1" } });
    adminDependencies.platformRoles = async () => ["platform_operator", "commercial_admin", "security_admin"];
    adminDependencies.assurance = async () => ({ sessionId: "session-1", userId: "operator-1", level: "password", method: "password", verifiedAt: new Date() });
    adminDependencies.enrolledFactor = async () => null;
    for (const [method, route] of [["GET", "${adminPath}"], ["POST", "${adminPath}"], ["PATCH", "${adminPath}/00000000-0000-4000-8000-000000000001"], ["DELETE", "${adminPath}/00000000-0000-4000-8000-000000000001"]] as const) {
      const response = await admin.request(route, { method, headers: { origin: "http://localhost:42070", "content-type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify({ values: { name: "x" }, expectedRevision: 1, reason: "test" }) }) }, environment);
      expect({ method, status: response.status, body: await response.json() }).toMatchObject({ method, status: 403, body: { reason: "permission_missing" } });
    }
  });
});
`);
  const importLine = `import { ${register} } from "./resources/${n.kebab}.js";`;
  const call = `${register}(admin, adminResourceHelpers);`;
  const nextWorker = withAdminRouteRegistration(workerSource, importLine, call, path.relative(root, admin.worker));
  if (nextWorker !== workerSource) await writeFile(admin.worker, nextWorker, "utf8");

  const label = `${n.className} catalog`;
  if (!registrySource.includes(`id: "${n.pluralKebab}"`)) {
    const entry = `  { id: "${n.pluralKebab}", path: "/catalog/${n.pluralKebab}", label: "${label}", group: "Operations", permission: "${permission}", api: [{ method: "GET", path: "${adminPath}" }, { method: "POST", path: "${adminPath}", permission: "${permission}" }, { method: "PATCH", path: "${adminPath}/:id", permission: "${permission}" }, { method: "DELETE", path: "${adminPath}/:id", permission: "${permission}" }] },\n`;
    await writeFile(admin.registry, registrySource.replace("  // trestle:admin-module-list", `${entry}  // trestle:admin-module-list`), "utf8");
  }
  await writeNew(admin.descriptor, `import { BooksIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "${n.pluralKebab}",
  path: "/catalog/${n.pluralKebab}",
  navigation: { label: "${label}", group: "Operations", order: 900, icon: BooksIcon },
  permission: "${permission}",
  component: () => import("./view"),
  commands: [{ id: "${n.pluralKebab}.open", label: "Go to ${label}" }],
});
`);
  const descriptors = resource.fields.map((field) => ({ name: field.name, type: field.type, required: field.required, ...(field.values ? { values: field.values } : {}) }));
  await writeNew(admin.view, `import { useRef, useState } from "react";

import { api } from "../../api";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdminQuery, useInvalidate } from "../../shell/context";
import { Button, Input, Select, Textarea } from "../../shell/kumo";
import { AdminDetailDrawer, AdminFacts, useSelectedDetail } from "../../shell/resource";
import { AdminDataTable, AdminPageHeader, AdminQueryState, AdminSection, formatDate } from "../../shell/ui";

type Row = { id: string; revision: number; createdAt: string; updatedAt: string } & Record<string, unknown>;
type Field = { name: string; type: string; required: boolean; values?: readonly string[] };
/** Generated from the resource declaration; the editor on the server validates every value again. */
const fields: readonly Field[] = ${JSON.stringify(descriptors)};
const display = (value: unknown) => value === null || value === undefined ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);
const toText = (field: Field, value: unknown) => value === null || value === undefined ? "" : field.type === "json" ? JSON.stringify(value, null, 2) : field.type === "datetime" ? String(value).slice(0, 16) : String(value);

/** Converts form text to values; blank optional fields are left out. */
function valuesOf(draft: Record<string, string>, changedOnly?: Row): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const text = (draft[field.name] ?? "").trim();
    if (changedOnly && text === toText(field, changedOnly[field.name]).trim()) continue;
    if (!text) { if (field.required) throw new Error(\`\${field.name} is required\`); continue; }
    values[field.name] = field.type === "integer" ? Number(text)
      : field.type === "boolean" ? text === "true"
        : field.type === "datetime" ? new Date(text).toISOString()
          : field.type === "json" ? JSON.parse(text) as unknown
            : text;
  }
  if (changedOnly && Object.keys(values).length === 0) throw new Error("Change at least one field");
  return values;
}

function FieldsEditor(props: { draft: { current: Record<string, string> } }) {
  const [state, setState] = useState(props.draft.current);
  const set = (name: string, value: string) => { const next = { ...state, [name]: value }; props.draft.current = next; setState(next); };
  return <div className="grid gap-3">{fields.map((field) => {
    const label = field.required ? field.name : \`\${field.name} (optional)\`;
    if (field.type === "enum" || field.type === "boolean") {
      const options = field.type === "boolean" ? ["true", "false"] : field.values ?? [];
      return <Select key={field.name} label={label} hideLabel={false} value={state[field.name] ?? ""} onValueChange={(value) => set(field.name, String(value ?? ""))}>
        {!field.required && <Select.Option value="">—</Select.Option>}
        {options.map((option) => <Select.Option key={option} value={option}>{option}</Select.Option>)}
      </Select>;
    }
    if (field.type === "json" || field.type === "text") return <Textarea key={field.name} label={label} value={state[field.name] ?? ""} onChange={(event: { target: { value: string } }) => set(field.name, event.target.value)} />;
    return <Input key={field.name} label={label} type={field.type === "integer" ? "number" : field.type === "datetime" ? "datetime-local" : "text"} value={state[field.name] ?? ""} onChange={(event) => set(field.name, event.target.value)} />;
  })}</div>;
}

/**
 * Shared ${n.className} records, which every tenant reads. Changes need ${permission},
 * a reason, and step-up; they are revision-checked and audited.
 */
export default function ${n.className}CatalogView() {
  const invalidate = useInvalidate();
  const confirm = useConfirmAction();
  const draft = useRef<Record<string, string>>({});
  const [pages, setPages] = useState<string[]>([]);
  const cursor = pages.at(-1);
  const records = useAdminQuery(["${n.pluralKebab}", cursor ?? ""], () => api.request<{ items: Row[]; nextCursor?: string }>("GET", "${n.pluralKebab}", undefined, { cursor }));
  const detail = useSelectedDetail(records.data?.items, (row) => row.id);
  const done = () => void invalidate("${n.pluralKebab}");
  const create = (): ConfirmConfig => {
    draft.current = {};
    return { title: "Add ${n.className}", confirmLabel: "Add", scope: ["Visible to every organization"], fields: <FieldsEditor draft={draft} />, onConfirm: (reason) => api.request("POST", "${n.pluralKebab}", { values: valuesOf(draft.current), reason }), onDone: done };
  };
  const edit = (row: Row): ConfirmConfig => {
    draft.current = Object.fromEntries(fields.map((field) => [field.name, toText(field, row[field.name])]));
    return { title: "Edit ${n.className}", confirmLabel: "Save", scope: [\`Changes \${display(row.name)} for every organization\`], fields: <FieldsEditor draft={draft} />, onConfirm: (reason) => api.request("PATCH", \`${n.pluralKebab}/\${encodeURIComponent(row.id)}\`, { values: valuesOf(draft.current, row), expectedRevision: row.revision, reason }), onDone: done };
  };
  const remove = (row: Row): ConfirmConfig => ({ title: "Delete ${n.className}", confirmLabel: "Delete", destructive: true, scope: [\`Deletes \${display(row.name)} for every organization\`], onConfirm: (reason) => api.request("DELETE", \`${n.pluralKebab}/\${encodeURIComponent(row.id)}\`, { expectedRevision: row.revision, reason }), onDone: done });
  return <>
    <AdminPageHeader title="${label}" description="Shared records every organization reads. Changes are audited." actions={<Button variant="primary" onClick={() => confirm.open(create())}>Add ${n.className}</Button>} />
    <AdminSection title="Records">
      <AdminQueryState query={records} isEmpty={(data) => data.items.length === 0} empty="No ${n.pluralKebab} yet.">{(data) => <>
        <AdminDataTable caption="${label}" rows={data.items} rowKey={(row) => row.id} rowLabel={(row) => display(row.name)}
          rowActions={(row) => [{ label: "Inspect", run: () => detail.select(row.id) }, { label: "Edit", run: () => confirm.open(edit(row)) }, { label: "Delete", destructive: true, run: () => confirm.open(remove(row)) }]}
          columns={[
            { header: "Name", cell: (row) => display(row.name) },
            { header: "Revision", cell: (row) => row.revision },
            { header: "Updated", cell: (row) => formatDate(row.updatedAt) },
          ]} />
        <div className="mt-3 flex gap-2">
          {pages.length > 0 && <Button onClick={() => setPages(pages.slice(0, -1))}>Previous</Button>}
          {data.nextCursor && <Button onClick={() => setPages([...pages, data.nextCursor!])}>Next</Button>}
        </div>
      </>}</AdminQueryState>
    </AdminSection>
    <AdminDetailDrawer title={detail.row ? display(detail.row.name) : "${n.className}"} open={detail.open} onClose={detail.close}>
      {detail.row && <AdminFacts items={[...fields.map((field) => [field.name, display(detail.row![field.name])] as const), ["Revision", detail.row.revision], ["Created", formatDate(detail.row.createdAt)], ["Updated", formatDate(detail.row.updatedAt)], ["ID", detail.row.id]]} />}
    </AdminDetailDrawer>
    {confirm.dialog}
  </>;
}
`);
  return created;
}
