import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectManifest, SetupResource } from "./core.js";

import { runCommand } from "./processes.js";
import { CliFailure } from "./runtime.js";

export type ResourceNames = {
  className: string;
  camel: string;
  kebab: string;
  snake: string;
  pluralKebab: string;
};

export type ResourceField = SetupResource["fields"][number];

const enumValuePattern = /^[a-z][a-z0-9_-]{0,62}$/u;

export function parseResourceField(value: string): ResourceField {
  const [name, type = "string", reference, onDelete = "restrict"] = value.split(":");
  const required = !type.endsWith("?");
  const typeSpec = type.replace(/\?$/u, "");
  const decimal = /^decimal(?:\((\d+),(\d+)\))?$/u.exec(typeSpec);
  const enumeration = /^enum(?:\((.*)\))?$/u.exec(typeSpec);
  const normalizedType = (decimal ? "decimal" : enumeration ? "enum" : typeSpec) as ResourceField["type"];
  if (!name || !/^[a-z][A-Za-z0-9]*$/u.test(name) || !["string", "text", "integer", "boolean", "datetime", "json", "decimal", "enum", "relation"].includes(normalizedType)) throw new CliFailure(`invalid field ${value}; expected name:type[?] or name:relation:Resource[:onDelete]`);
  if (["id", "organizationId", "revision", "createdAt", "updatedAt"].includes(name)) throw new CliFailure(`field ${name} is reserved for resource identity and versioning`);
  if (normalizedType === "relation") {
    if (!reference || !/^[A-Z][A-Za-z0-9]*$/u.test(reference) || !["restrict", "cascade", "set-null"].includes(onDelete)) throw new CliFailure(`invalid relationship field ${value}`);
    if (required) throw new CliFailure("relationship fields must initially be optional; use name:relation?:Resource:onDelete");
    return { name, type: normalizedType, required, references: { resource: reference, onDelete: onDelete as "restrict" | "cascade" | "set-null" } };
  }
  if (reference) throw new CliFailure(`non-relation field ${name} cannot reference ${reference}`);
  if (decimal) {
    if (decimal[1] === undefined || decimal[2] === undefined) throw new CliFailure(`decimal field ${name} must declare decimal(precision,scale), for example ${name}:decimal(10,2)?`);
    const precision = Number(decimal[1]);
    const scale = Number(decimal[2]);
    if (precision < 1 || precision > 1000 || scale > precision) throw new CliFailure(`decimal field ${name} needs 1 <= precision <= 1000 and a scale no larger than its precision`);
    return { name, type: "decimal", required, precision, scale };
  }
  if (enumeration) {
    const values = enumeration[1] ? enumeration[1].split("|") : [];
    if (!values.length) throw new CliFailure(`enum field ${name} must declare enum(value|value), for example ${name}:enum(draft|published)?`);
    if (values.length > 50 || new Set(values).size !== values.length || values.some((entry) => !enumValuePattern.test(entry))) throw new CliFailure(`enum values for ${name} must be 1 to 50 unique lowercase identifiers`);
    return { name, type: "enum", required, values };
  }
  return { name, type: normalizedType, required };
}

function zodExpression(field: ResourceField): string {
  const base = field.type === "string" ? "z.string().trim().min(1).max(200)"
    : field.type === "text" ? "z.string().max(10000)"
    : field.type === "integer" ? "z.number().int()"
    : field.type === "boolean" ? "z.boolean()"
    : field.type === "datetime" ? "z.coerce.date()"
    : field.type === "json" ? "z.json()"
    // Decimals travel as strings so no digits are lost to floating point.
    : field.type === "decimal" ? `z.string().regex(/^-?\\d{1,${Math.max(field.precision! - field.scale!, 1)}}${field.scale! > 0 ? `(\\.\\d{1,${field.scale!}})?` : ""}$/u)`
    : field.type === "enum" ? `z.enum([${field.values!.map((entry) => JSON.stringify(entry)).join(", ")}])`
    : "z.string().uuid()";
  return field.required ? base : `${base}.optional()`;
}

/** Update change detection casts types whose parameters PostgreSQL cannot compare untyped. */
function changedExpression(resource: ResourceNames, field: ResourceField): string {
  const value = field.type === "json" ? `\${JSON.stringify(input.${field.name})}::jsonb`
    : field.type === "decimal" ? `\${input.${field.name}}::numeric`
    : `\${input.${field.name}}`;
  return `input.${field.name} !== undefined ? sql\`\${${resource.camel}.${field.name}} is distinct from ${value}\` : undefined,`;
}

/** Enum fields are also constrained in the database, so rows written outside the API stay valid. */
function fieldCheckExpression(resource: ResourceNames, field: ResourceField): string | undefined {
  if (field.type !== "enum") return undefined;
  return `  check("${constraintName(`${resource.snake}_${columnName(field)}_values`)}", sql\`\${table.${field.name}} in (${field.values!.map((entry) => `'${entry}'`).join(", ")})\`),`;
}

function pgCoreImports(fields: readonly ResourceField[]): string[] {
  return [
    ...(fields.some((field) => field.type === "json") ? ["jsonb"] : []),
    ...(fields.some((field) => field.type === "decimal") ? ["numeric"] : []),
    ...(fields.some((field) => field.type === "enum") ? ["check"] : []),
  ];
}

export function columnName(field: ResourceField): string {
  return field.name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

function columnExpression(field: ResourceField): string {
  const column = columnName(field);
  // Relations are plain columns here; the tenant-scoped composite key is declared with the table (relationKeyExpression).
  const base = field.type === "integer" ? `integer("${column}")`
    : field.type === "boolean" ? `boolean("${column}")`
    : field.type === "datetime" ? `timestamp("${column}", { withTimezone: true })`
    : field.type === "relation" ? `uuid("${column}")`
    : field.type === "json" ? `jsonb("${column}").$type<JsonValue>()`
    : field.type === "decimal" ? `numeric("${column}", { precision: ${field.precision}, scale: ${field.scale} })`
    : field.type === "enum" ? `text("${column}", { enum: [${field.values!.map((entry) => JSON.stringify(entry)).join(", ")}] })`
    : `text("${column}")`;
  return field.required ? `${base}.notNull()` : base;
}

const jsonValueImport = 'import type { JsonValue } from "./json-value.js";';
const jsonValueSource = `/** A JSON value, matching the contracts' z.json() type, for jsonb columns. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
`;

/** Generated jsonb columns type their values with the shared JsonValue alias. */
async function ensureJsonValueType(dbSource: string): Promise<string | undefined> {
  const target = path.join(dbSource, "json-value.ts");
  if (await exists(target)) return undefined;
  await writeFile(target, jsonValueSource, "utf8");
  return target;
}

function exampleExpression(field: ResourceField): string {
  if (field.type === "json") return '{ example: true }';
  if (field.type === "decimal") return field.scale! > 0 ? `"1.${"2".repeat(Math.min(field.scale!, 2))}"` : '"12"';
  if (field.type === "enum") return JSON.stringify(field.values![0]);
  if (field.type === "integer") return "42";
  if (field.type === "boolean") return "true";
  if (field.type === "datetime") return '"2026-01-01T00:00:00.000Z"';
  if (field.type === "relation") return '"00000000-0000-4000-8000-000000000001"';
  return `"${field.name === "name" ? "Example" : "Example value"}"`;
}

export function names(name: string): ResourceNames {
  if (!/^[A-Z][A-Za-z0-9]*$/u.test(name)) throw new CliFailure("resource name must be PascalCase");
  const words = name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").split(" ").map((word) => word.toLowerCase());
  const kebab = words.join("-");
  return {
    className: name,
    camel: `${words[0]}${words.slice(1).map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`).join("")}`,
    kebab,
    snake: words.join("_"),
    pluralKebab: kebab.endsWith("s") ? `${kebab}es` : `${kebab}s`,
  };
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false);
}

/** PostgreSQL truncates identifiers past 63 bytes, so long constraint names end in a stable digest instead. */
function constraintName(value: string): string {
  if (value.length <= 63) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${value.slice(0, 63 - digest.length - 1).replace(/_+$/u, "")}_${digest}`;
}

export function tenantKeyName(resource: ResourceNames): string {
  return constraintName(`${resource.snake}_tenant_key`);
}

export function relationKeyName(resource: ResourceNames, field: ResourceField): string {
  return constraintName(`${resource.snake}_${columnName(field)}_tenant_fk`);
}

/**
 * A relation references the parent's (organization_id, id), so a row can only
 * point at a parent in its own tenant. set-null is narrowed to the relation
 * column in the migration (generateResourceMigration) so it never nulls tenant identity.
 */
export function relationKeyExpression(resource: ResourceNames, field: ResourceField): string {
  const related = names(field.references!.resource);
  const action = field.references!.onDelete === "set-null" ? "set null" : field.references!.onDelete;
  return `  foreignKey({ name: "${relationKeyName(resource, field)}", columns: [table.organizationId, table.${field.name}], foreignColumns: [${related.camel}.organizationId, ${related.camel}.id] }).onDelete("${action}"),`;
}

/** Relations may only target another generated tenant resource. Checked before any file is written. */
async function assertRelationTargets(root: string, dbPath: string, resourceName: string, fields: readonly ResourceField[]): Promise<void> {
  for (const field of fields.filter(({ type }) => type === "relation")) {
    const target = field.references!.resource;
    if (target === resourceName) throw new CliFailure(`${resourceName}.${field.name} cannot reference its own resource; self-relations are not generated yet`);
    const related = names(target);
    const declaration = await readFile(path.join(root, ".trestle", "resources", `${related.kebab}.json`), "utf8").then((source) => JSON.parse(source) as { tenant?: unknown }, () => undefined);
    if (declaration?.tenant !== true || !(await exists(path.join(root, dbPath, "src", `${related.kebab}-schema.ts`)))) {
      throw new CliFailure(`${resourceName}.${field.name} references ${target}, which is not a generated tenant resource; generate ${target} first`);
    }
  }
}

export function withPgCoreImports(source: string, required: readonly string[]): string {
  return source.replace(/import \{([^}]*)\} from "drizzle-orm\/pg-core";/u, (_line, imported: string) => {
    const list = [...new Set([...imported.split(",").map((name) => name.trim()).filter(Boolean), ...required])].sort((a, b) => a.localeCompare(b));
    return `import { ${list.join(", ")} } from "drizzle-orm/pg-core";`;
  });
}

/** Gives a parent generated before tenant keys existed the (organization_id, id) key its children reference. */
export async function ensureTenantKey(schemaPath: string, parent: ResourceNames): Promise<boolean> {
  const source = await readFile(schemaPath, "utf8");
  if (source.includes(`"${tenantKeyName(parent)}"`)) return false;
  const anchor = `  index("${parent.snake}_organization_idx").on(table.organizationId),`;
  if (!source.includes(anchor)) throw new CliFailure(`${parent.className} schema has no tenant index anchor; add unique("${tenantKeyName(parent)}").on(table.organizationId, table.id) to it before relating to it`);
  await writeFile(schemaPath, withPgCoreImports(source.replace(anchor, `${anchor}\n  unique("${tenantKeyName(parent)}").on(table.organizationId, table.id),`), ["unique"]), "utf8");
  return true;
}

async function appendExport(target: string, exportLine: string): Promise<void> {
  const source = await readFile(target, "utf8");
  if (source.includes(exportLine)) return;
  await writeFile(target, `${source.trimEnd()}\n${exportLine}\n`, "utf8");
}

/** Real-PostgreSQL proof that the composite key rejects cross-tenant links and keeps tenant identity on delete. */
function relationIntegrationTest(resource: ResourceNames, field: ResourceField): string {
  const related = names(field.references!.resource);
  const column = columnName(field);
  const onDelete = field.references!.onDelete;
  const afterParentDelete = onDelete === "set-null"
    ? `      await sql!\`delete from ${related.snake} where id = \${parent!.id}\`;
      expect((await sql!\`select organization_id, ${column} from ${resource.snake} where id = \${linked!.id}\`)[0]).toMatchObject({ organization_id: "org-b", ${column}: null });`
    : onDelete === "cascade"
      ? `      await sql!\`delete from ${related.snake} where id = \${parent!.id}\`;
      expect(await sql!\`select id from ${resource.snake} where id = \${linked!.id}\`).toHaveLength(0);`
      : `      await expect(sql!\`delete from ${related.snake} where id = \${parent!.id}\`).rejects.toThrow(/${relationKeyName(resource, field)}/u);`;
  return `
  it("keeps ${field.name} inside the row's tenant", async () => {
    const [parent] = await sql!\`insert into ${related.snake} (organization_id, name) values ('org-b', \${\`\${prefix}parent\`}) returning id\`;
    try {
      await expect(sql!\`insert into ${resource.snake} (organization_id, name, ${column}) values ('org-a', \${\`\${prefix}cross\`}, \${parent!.id})\`).rejects.toThrow(/${relationKeyName(resource, field)}/u);
      const [linked] = await sql!\`insert into ${resource.snake} (organization_id, name, ${column}) values ('org-b', \${\`\${prefix}same\`}, \${parent!.id}) returning id\`;
      expect(linked).toBeDefined();
${afterParentDelete}
    } finally {
      await sql!\`delete from ${resource.snake} where name = \${\`\${prefix}same\`}\`;
      await sql!\`delete from ${related.snake} where id = \${parent!.id}\`;
    }
  });
`;
}

export async function generateResource(root: string, manifest: ProjectManifest, resource: SetupResource): Promise<string[]> {
  const contextSource = await readFile(path.join(root, manifest.packages.context ?? "packages/context", "src", "index.ts"), "utf8").catch(() => undefined);
  if (contextSource && !/export const AUTHORITY_MODEL_VERSION\s*=\s*(?:[3-9]|\d{2,})\s*;/u.test(contextSource)) {
    throw new CliFailure("resource generation requires independent application authority; migrate to the permission-registry ExecutionContext (authority model 3) before generating new routes");
  }
  const n = names(resource.name);
  const webhookEvents = (["created", "updated", "deleted"] as const).filter((kind) => resource.webhookEvents.includes(kind));
  const project = manifest.project.name;
  const contractsPath = manifest.packages.contracts ?? "packages/contracts";
  const domainPath = manifest.packages.domain ?? "packages/domain";
  const dataPath = manifest.packages.data ?? "packages/data";
  const dbPath = manifest.packages.db ?? "packages/db";
  const eventsPath = manifest.packages.events ?? "packages/events";
  const workerPath = manifest.apps.worker ?? "apps/worker";
  const appPath = manifest.apps.app ?? "apps/app";
  const catalogPath = path.join(root, eventsPath, "src", "application-catalog.ts");
  const declarationPath = path.join(root, ".trestle", "resources", `${n.kebab}.json`);
  const targets = [
    declarationPath,
    path.join(root, contractsPath, "src", "resources", `${n.kebab}.ts`),
    path.join(root, domainPath, "src", "resources", `${n.kebab}.ts`),
    path.join(root, dataPath, "src", "resources", `${n.kebab}-repository.ts`),
    path.join(root, dbPath, "src", `${n.kebab}-schema.ts`),
    path.join(root, workerPath, "src", "resources", `${n.kebab}-routes.ts`),
    path.join(root, appPath, "src", "resources", `${n.kebab}.tsx`),
    path.join(root, contractsPath, "src", "resources", `${n.kebab}.test.ts`),
    path.join(root, dbPath, "src", `${n.kebab}-rls.integration.test.ts`),
    path.join(root, appPath, "src", "api", `${n.kebab}.ts`),
    path.join(root, workerPath, "src", "resources", `${n.kebab}-events.ts`),
    path.join(root, dataPath, "src", "resources", `${n.kebab}-events.integration.test.ts`),
    path.join(root, eventsPath, "src", "resources", `${n.kebab}-webhooks.test.ts`),
  ];
  const declarationExists = await exists(declarationPath);
  const collisions = (await Promise.all(targets.map(async (target) => (await exists(target) ? target : undefined)))).filter((target): target is string => Boolean(target));
  if (collisions.length && !declarationExists) throw new CliFailure(`resource ${resource.name} collides with existing files: ${collisions.join(", ")}`);
  if (declarationExists) {
    const current = JSON.parse(await readFile(declarationPath, "utf8")) as { name?: string; tenant?: boolean; crud?: boolean; fields?: unknown; webhookEvents?: unknown; authorization?: unknown; pagination?: unknown };
    const intended = { fields: resource.fields, authorization: resource.authorization ?? { read: "resource.read", write: "resource.write" }, pagination: resource.pagination };
    if (current.name !== resource.name || current.tenant !== resource.tenant || current.crud !== resource.crud || JSON.stringify({ fields: current.fields, authorization: current.authorization, pagination: current.pagination }) !== JSON.stringify(intended)
      || JSON.stringify((["created", "updated", "deleted"] as const).filter((kind) => Array.isArray(current.webhookEvents) && current.webhookEvents.includes(kind))) !== JSON.stringify(webhookEvents)) {
      throw new CliFailure(`resource ${resource.name} already exists with a different declaration`);
    }
  }
  const catalogSource = await readFile(catalogPath, "utf8").catch(() => undefined);
  if (!catalogSource?.includes("// trestle:resource-event-definitions") || !catalogSource.includes("// trestle:resource-event-list")) {
    throw new CliFailure("resource generation requires the application event catalog registration anchors; review and upgrade packages/events/src/application-catalog.ts before generating another resource");
  }
  const eventKinds = ["created", "updated", "deleted"] as const;
  const eventSymbols = eventKinds.map((kind) => `${n.camel}${kind[0]!.toUpperCase()}${kind.slice(1)}ApplicationEvent`);
  for (const eventSymbol of eventSymbols) {
    const hasDefinition = catalogSource.includes(`export const ${eventSymbol} = defineEvent(`);
    const hasRegistration = catalogSource.includes(`  ${eventSymbol},`);
    if (hasDefinition !== hasRegistration) throw new CliFailure(`resource ${resource.name} has an incomplete application event catalog registration`);
  }
  const hasDefinition = catalogSource.includes(`export const ${eventSymbols[0]} = defineEvent(`);
  const changeDefinitions = eventSymbols.slice(1).map((symbol) => catalogSource.includes(`export const ${symbol} = defineEvent(`));
  if (changeDefinitions.some(Boolean) && !changeDefinitions.every(Boolean)) throw new CliFailure(`resource ${resource.name} has an incomplete change-event catalog`);
  if (!declarationExists && hasDefinition) throw new CliFailure(`resource ${resource.name} has an event registration but no resource declaration`);
  if (declarationExists && !hasDefinition) throw new CliFailure(`resource ${resource.name} has no application event registration; review its application-owned source`);
  const hasChangeDefinitions = changeDefinitions.every(Boolean);
  const emitsChangeEvents = !declarationExists || hasChangeDefinitions;
  if (declarationExists && hasChangeDefinitions !== catalogSource.includes(`  ${eventSymbols[1]},`)) {
    throw new CliFailure(`resource ${resource.name} has an incomplete change-event catalog registration`);
  }
  if (declarationExists && !emitsChangeEvents) {
    const missing = (await Promise.all(targets.slice(1, 11).map(async (target) => (await exists(target) ? undefined : target))))
      .filter((target): target is string => Boolean(target));
    if (missing.length) throw new CliFailure(`resource ${resource.name} uses the earlier create-only event contract; review and restore its application-owned source before regeneration: ${missing.join(", ")}`);
    return [];
  }

  await assertRelationTargets(root, dbPath, resource.name, resource.fields);
  for (const target of targets) await mkdir(path.dirname(target), { recursive: true });
  const created: string[] = [];
  const writeGenerated = async (target: string, source: string) => {
    if (await exists(target)) return;
    await writeFile(target, source, "utf8");
    created.push(path.relative(root, target));
  };
  const routePath = `/api/${n.pluralKebab}`;
  const eventName = `resource.${n.snake}.created`;
  const updatedEventName = `resource.${n.snake}.updated`;
  const deletedEventName = `resource.${n.snake}.deleted`;
  const readPermission = resource.authorization?.read ?? "resource.read";
  const writePermission = resource.authorization?.write ?? "resource.write";

  const declaration = {
    schemaVersion: 2,
    name: resource.name,
    tenant: resource.tenant,
    crud: resource.crud,
    fields: resource.fields,
    webhookEvents,
    authorization: { read: readPermission, write: writePermission },
    pagination: resource.pagination,
    persistence: { table: n.snake, schema: path.relative(root, targets[4]!) },
    contracts: path.relative(root, targets[1]!),
    files: [...targets.slice(1, 11), ...(emitsChangeEvents ? [targets[11]!] : []), ...(webhookEvents.length ? [targets[12]!] : [])].map((target) => path.relative(root, target)),
    registrations: [path.join(workerPath, "src", "index.ts"), path.join(appPath, "src", "main.tsx")],
    routes: resource.crud ? [
      { method: "GET", path: routePath, auth: true },
      { method: "POST", path: routePath, auth: true },
      { method: "GET", path: `${routePath}/:id`, auth: true },
      { method: "PATCH", path: `${routePath}/:id`, auth: true },
      { method: "DELETE", path: `${routePath}/:id`, auth: true },
    ] : [],
  };
  await writeFile(declarationPath, `${JSON.stringify(declaration, null, 2)}\n`, "utf8");
  if (!declarationExists) created.push(path.relative(root, declarationPath));

  await writeGenerated(targets[1]!, `import { z } from "zod";

export const ${n.camel}CreateSchema = z.object({
${resource.fields.map((field) => `  ${field.name}: ${zodExpression(field)},`).join("\n")}
});
export const ${n.camel}UpdateSchema = ${n.camel}CreateSchema.partial().refine((value) => Object.keys(value).length > 0, "at least one field is required");
export const ${n.camel}Schema = z.object({
${resource.fields.map((field) => `  ${field.name}: ${field.required ? zodExpression(field) : `${zodExpression({ ...field, required: true })}.nullable()`},`).join("\n")}
  id: z.string().uuid(),
  organizationId: z.string().min(1),
  revision: z.number().int().positive(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ${n.className} = z.infer<typeof ${n.camel}Schema>;
export type Create${n.className} = z.infer<typeof ${n.camel}CreateSchema>;
export type Update${n.className} = z.infer<typeof ${n.camel}UpdateSchema>;
`);

  await writeGenerated(targets[2]!, `import type { ${n.className}, Create${n.className}, Update${n.className} } from "@${project}/contracts";

export interface ${n.className}Repository {
  list(input: { cursor?: string; limit: number }): Promise<{ items: ${n.className}[]; nextCursor?: string }>;
  get(id: string): Promise<${n.className} | null>;
  create(input: Create${n.className}): Promise<${n.className}>;
  update(id: string, input: Update${n.className}): Promise<${n.className} | null>;
  remove(id: string): Promise<boolean>;
}

export class ${n.className}Service {
  constructor(private readonly repository: ${n.className}Repository) {}
  list(input: { cursor?: string; limit: number }) { return this.repository.list(input); }
  get(id: string) { return this.repository.get(id); }
  create(input: Create${n.className}) { return this.repository.create(input); }
  update(id: string, input: Update${n.className}) { return this.repository.update(id, input); }
  remove(id: string) { return this.repository.remove(id); }
}
`);

  await writeGenerated(targets[3]!, `import type { ${n.className}, Create${n.className}, Update${n.className} } from "@${project}/contracts";
import { ${n.camel}, type Database } from "@${project}/db";
import type { ${n.className}Repository } from "@${project}/domain";
import { and, asc, eq, gt, or, sql, type SQL } from "drizzle-orm";

type ResourceEvents = { statement(name: string, payload: unknown, options: { schemaVersion?: number; idempotencyKey: string }): SQL };

export class Postgres${n.className}Repository implements ${n.className}Repository {
  constructor(private readonly database: Database, private readonly organizationId: string, private readonly events: ResourceEvents, private readonly clock: { now(): Date } = { now: () => new Date() }) {}
  async list(input: { cursor?: string; limit: number }): Promise<{ items: ${n.className}[]; nextCursor?: string }> {
    const rows = await this.database.select().from(${n.camel}).where(and(eq(${n.camel}.organizationId, this.organizationId), input.cursor ? gt(${n.camel}.id, input.cursor) : undefined)).orderBy(asc(${n.camel}.id)).limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    return { items, ...(hasMore && items.at(-1) ? { nextCursor: items.at(-1)!.id } : {}) };
  }
  async get(id: string): Promise<${n.className} | null> {
    const [record] = await this.database.select().from(${n.camel}).where(and(eq(${n.camel}.id, id), eq(${n.camel}.organizationId, this.organizationId))).limit(1);
    return record ?? null;
  }
  async create(input: Create${n.className}): Promise<${n.className}> {
    return this.database.transaction(async (transaction) => {
      const [record] = await transaction.insert(${n.camel}).values({ ...input, organizationId: this.organizationId }).returning();
      if (!record) throw new Error("Failed to create ${n.className}");
      await transaction.execute(this.events.statement("${eventName}", { resourceId: record.id }, {
        schemaVersion: 1, idempotencyKey: "${eventName}:" + record.id,
      }));
      return record;
    });
  }
  async update(id: string, input: Update${n.className}): Promise<${n.className} | null> {
    return this.database.transaction(async (transaction) => {
      const changed = or(
${resource.fields.map((field) => `        ${changedExpression(n, field)}`).join("\n")}
      );
      if (!changed) {
        const [record] = await transaction.select().from(${n.camel}).where(and(eq(${n.camel}.id, id), eq(${n.camel}.organizationId, this.organizationId))).limit(1);
        return record ?? null;
      }
      const [record] = await transaction.update(${n.camel})
        .set({ ...input, revision: sql\`\${${n.camel}.revision} + 1\`, updatedAt: this.clock.now() })
        .where(and(eq(${n.camel}.id, id), eq(${n.camel}.organizationId, this.organizationId), changed)).returning();
      if (!record) {
        const [current] = await transaction.select().from(${n.camel}).where(and(eq(${n.camel}.id, id), eq(${n.camel}.organizationId, this.organizationId))).limit(1);
        return current ?? null;
      }
      await transaction.execute(this.events.statement("${updatedEventName}", { resourceId: record.id, revision: record.revision }, {
        schemaVersion: 1, idempotencyKey: "${updatedEventName}:" + record.id + ":" + record.revision,
      }));
      return record;
    });
  }
  async remove(id: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [record] = await transaction.delete(${n.camel}).where(and(eq(${n.camel}.id, id), eq(${n.camel}.organizationId, this.organizationId))).returning();
      if (!record) return false;
      await transaction.execute(this.events.statement("${deletedEventName}", { resourceId: record.id, revision: record.revision }, {
        schemaVersion: 1, idempotencyKey: "${deletedEventName}:" + record.id,
      }));
      return true;
    });
  }
}
`);

  const relations = resource.fields.filter((field) => field.type === "relation");
  for (const related of [...new Set(relations.map((field) => field.references!.resource))]) {
    const parentSchema = path.join(root, dbPath, "src", `${names(related).kebab}-schema.ts`);
    if (await ensureTenantKey(parentSchema, names(related))) created.push(path.relative(root, parentSchema));
  }
  const hasJson = resource.fields.some((field) => field.type === "json");
  if (hasJson) {
    const jsonValue = await ensureJsonValueType(path.dirname(targets[4]!));
    if (jsonValue) created.push(path.relative(root, jsonValue));
  }
  await writeGenerated(targets[4]!, `import { sql } from "drizzle-orm";
import { ${["boolean", ...(relations.length ? ["foreignKey"] : []), "index", "integer", "pgPolicy", "pgTable", "text", "timestamp", "unique", "uuid", ...pgCoreImports(resource.fields)].sort((a, b) => a.localeCompare(b)).join(", ")} } from "drizzle-orm/pg-core";
${hasJson ? `${jsonValueImport}\n` : ""}${[...new Set(resource.fields.filter((field) => field.type === "relation").map((field) => field.references!.resource))].map((related) => `import { ${names(related).camel} } from "./${names(related).kebab}-schema.js";`).join("\n")}

export const ${n.camel} = pgTable("${n.snake}", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
${resource.fields.map((field) => `  ${field.name}: ${columnExpression(field)},`).join("\n")}
  revision: integer("revision").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("${n.snake}_organization_idx").on(table.organizationId),
  unique("${tenantKeyName(n)}").on(table.organizationId, table.id),
${relations.map((field) => `${relationKeyExpression(n, field)}\n`).join("")}${resource.fields.map((field) => fieldCheckExpression(n, field)).filter(Boolean).map((line) => `${line}\n`).join("")}  pgPolicy("${n.snake}_tenant", {
    for: "all",
    to: "trestle_app",
    using: sql\`\${table.organizationId} = current_setting('app.organization_id', true)\`,
    withCheck: sql\`\${table.organizationId} = current_setting('app.organization_id', true)\`,
  }),
]).enableRLS();
`);

  await writeGenerated(targets[5]!, `import { type AuthEnvironment } from "@${project}/auth";
import { ${n.camel}CreateSchema, ${n.camel}UpdateSchema } from "@${project}/contracts";
import { Postgres${n.className}Repository } from "@${project}/data";
import { ${n.className}Service } from "@${project}/domain";
import { Hono } from "hono";

import { requireExecutionContext, type AppVariables } from "../execution-context.js";

export const ${n.camel}Routes = new Hono<{ Bindings: AuthEnvironment; Variables: AppVariables }>();
${n.camel}Routes.use("${routePath}", requireExecutionContext);
${n.camel}Routes.use("${routePath}/*", requireExecutionContext);
function service(execution: AppVariables["execution"]) {
  return new ${n.className}Service(new Postgres${n.className}Repository(execution.data, execution.tenant.organizationId, execution.events, execution.clock));
}
async function operation<T>(execution: AppVariables["execution"], event: string, work: () => Promise<T>): Promise<T> {
  const started = execution.clock.now().getTime();
  execution.log.info(event + ".started");
  try {
    const result = await work();
    execution.log.info(event + ".completed", { durationMs: execution.clock.now().getTime() - started });
    return result;
  } catch (error) {
    execution.log.error(event + ".failed", { durationMs: execution.clock.now().getTime() - started, errorName: error instanceof Error ? error.name : "UnknownError" });
    throw error;
  }
}
${n.camel}Routes.get("${routePath}", async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "${readPermission}" });
  const cursor = context.req.query("cursor");
  const requestedLimit = Number(context.req.query("limit") ?? "${resource.pagination.defaultLimit}");
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > ${resource.pagination.maxLimit}) return context.json({ error: "validation_failed", message: "limit must be between 1 and ${resource.pagination.maxLimit}" }, 400);
  if (cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(cursor)) return context.json({ error: "validation_failed", message: "cursor must be a UUID" }, 400);
  const page = await operation(execution, "resource.${n.kebab}.list", () => service(execution).list({ ...(cursor ? { cursor } : {}), limit: requestedLimit }));
  return context.json({ ${n.camel}s: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
});
${n.camel}Routes.post("${routePath}", async (context) => {
  const parsed = ${n.camel}CreateSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  const execution = context.get("execution");
  execution.access.require({ permission: "${writePermission}" });
  return context.json({ ${n.camel}: await operation(execution, "resource.${n.kebab}.create", () => service(execution).create(parsed.data)) }, 201);
});
${n.camel}Routes.get("${routePath}/:id", async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "${readPermission}" });
  const record = await operation(execution, "resource.${n.kebab}.read", () => service(execution).get(context.req.param("id")));
  return record ? context.json({ ${n.camel}: record }) : context.json({ error: "Not found" }, 404);
});
${n.camel}Routes.patch("${routePath}/:id", async (context) => {
  const parsed = ${n.camel}UpdateSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  const execution = context.get("execution");
  execution.access.require({ permission: "${writePermission}" });
  const updated = await operation(execution, "resource.${n.kebab}.update", () => service(execution).update(context.req.param("id"), parsed.data));
  return updated ? context.json({ ${n.camel}: updated }) : context.json({ error: "Not found" }, 404);
});
${n.camel}Routes.delete("${routePath}/:id", async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "${writePermission}" });
  return await operation(execution, "resource.${n.kebab}.delete", () => service(execution).remove(context.req.param("id"))) ? context.body(null, 204) : context.json({ error: "Not found" }, 404);
});
`);

  await writeGenerated(targets[6]!, `import { ${n.camel}CreateSchema, ${n.camel}Schema, ${n.camel}UpdateSchema, type ${n.className} } from "@${project}/contracts";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { authClient } from "../auth-client.js";
import { create${n.className}Api } from "../api/${n.kebab}.js";

export function ${n.className}Screen() {
  const { data: session } = authClient.useSession();
  const activeOrganization = authClient.useActiveOrganization();
  const organizationId = activeOrganization.data?.id;
  const api = session?.user.id && organizationId ? create${n.className}Api(organizationId) : undefined;
  const queryClient = useQueryClient();
  const key = ["${n.pluralKebab}", session?.user.id, organizationId] as const;
  const [editing, setEditing] = useState<${n.className} | null>(null);
  const [editingName, setEditingName] = useState("");
  const query = useQuery({
    queryKey: key,
    enabled: Boolean(session?.user.id && organizationId),
    queryFn: async () => (await api!.list()).items,
  });
  const create = useMutation({ mutationFn: async (input: unknown) => {
    return await api!.create(${n.camel}CreateSchema.parse(input));
  }, onSuccess: async () => await queryClient.invalidateQueries({ queryKey: key }) });
  const update = useMutation({ mutationFn: async (input: { id: string; name: string }) => {
    return await api!.update(input.id, ${n.camel}UpdateSchema.parse({ name: input.name }));
  }, onSuccess: async () => { setEditing(null); await queryClient.invalidateQueries({ queryKey: key }); } });
  const remove = useMutation({ mutationFn: async (id: string) => await api!.remove(id), onSuccess: async () => await queryClient.invalidateQueries({ queryKey: key }) });
  const form = useForm({ defaultValues: { name: "" }, onSubmit: async ({ value }) => { await create.mutateAsync(value); form.reset(); } });
  const error = query.error ?? create.error ?? update.error ?? remove.error;
  if (!session?.user.id || !organizationId) return <section className="card p-8"><h1 className="text-3xl font-semibold">${n.className}</h1><p className="mt-4 text-slate-600">Sign in and select an organization before managing ${n.pluralKebab}.</p></section>;
  return <section className="card p-8">
    <h1 className="text-3xl font-semibold">${n.className}</h1>
    <form className="mt-6 flex gap-3" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
      <form.Field name="name">{(field) => <input aria-label="New ${n.className} name" className="min-w-0 flex-1 rounded-xl border px-4 py-3" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} />}</form.Field>
      <button className="button" disabled={create.isPending} type="submit">{create.isPending ? "Creating…" : "Create"}</button>
    </form>
    {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">{error.message}</p>}
    {query.isPending ? <p className="mt-6 text-slate-600">Loading…</p> : query.data?.length === 0 ? <p className="mt-6 text-slate-600">No ${n.pluralKebab} yet.</p> : <ul className="mt-6 space-y-2">{query.data?.map((record) => <li className="rounded-xl border p-4" key={record.id}>{editing?.id === record.id ? <div className="flex gap-3"><input aria-label="Edit ${n.className} name" className="min-w-0 flex-1 rounded-lg border px-3 py-2" value={editingName} onChange={(event) => setEditingName(event.target.value)} /><button className="button" onClick={() => void update.mutateAsync({ id: record.id, name: editingName })}>Save</button><button className="text-sm font-semibold" onClick={() => setEditing(null)}>Cancel</button></div> : <div className="flex items-center justify-between gap-4"><span>{record.name}</span><span className="flex gap-3"><button className="text-sm font-semibold text-brand-500" onClick={() => { setEditing(record); setEditingName(record.name); }}>Edit</button><button className="text-sm font-semibold text-red-600" onClick={() => void remove.mutateAsync(record.id)}>Delete</button></span></div>}</li>)}</ul>}
  </section>;
}
`);

  await writeGenerated(targets[9]!, `import { ${n.camel}CreateSchema, ${n.camel}Schema, ${n.camel}UpdateSchema, type Create${n.className}, type ${n.className}, type Update${n.className} } from "@${project}/contracts";

const apiOrigin = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\\\/$/u, "") ?? "";
async function request<T>(organizationId: string, pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(\`${"${apiOrigin}"}\${pathname}\`, { ...init, credentials: "include", headers: { "content-type": "application/json", "x-trestle-tenant": organizationId, ...init?.headers } });
  const body = response.status === 204 ? undefined : await response.json();
  if (!response.ok) throw new Error((body as { message?: string; error?: string } | undefined)?.message ?? (body as { error?: string } | undefined)?.error ?? \`Request failed (\${response.status})\`);
  return body as T;
}

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
    async create(input: Create${n.className}): Promise<${n.className}> { const result = await request<{ ${n.camel}: unknown }>(organizationId, "${routePath}", { method: "POST", body: JSON.stringify(${n.camel}CreateSchema.parse(input)) }); return ${n.camel}Schema.parse(result.${n.camel}); },
    async update(id: string, input: Update${n.className}): Promise<${n.className}> { const result = await request<{ ${n.camel}: unknown }>(organizationId, \`${routePath}/\${id}\`, { method: "PATCH", body: JSON.stringify(${n.camel}UpdateSchema.parse(input)) }); return ${n.camel}Schema.parse(result.${n.camel}); },
    async remove(id: string): Promise<void> { await request<void>(organizationId, \`${routePath}/\${id}\`, { method: "DELETE" }); },
  };
}
`);

  await writeGenerated(targets[10]!, `import { applicationEventCatalog, type EventDefinition, type EventEnvelope } from "@${project}/events";
import type { EventHandlerContext } from "../async-runtime.js";

export type ${n.className}CreatedPayload = { resourceId: string };
export type ${n.className}UpdatedPayload = { resourceId: string; revision: number };
export type ${n.className}DeletedPayload = { resourceId: string; revision: number };

export const ${n.camel}CreatedEvent: EventDefinition<${n.className}CreatedPayload> = {
  name: "${eventName}",
  schemaVersion: 1,
  parse(payload: unknown): ${n.className}CreatedPayload {
    return applicationEventCatalog.parse("${eventName}", 1, payload) as ${n.className}CreatedPayload;
  },
};
export const ${n.camel}UpdatedEvent: EventDefinition<${n.className}UpdatedPayload> = {
  name: "${updatedEventName}",
  schemaVersion: 1,
  parse(payload: unknown): ${n.className}UpdatedPayload {
    return applicationEventCatalog.parse("${updatedEventName}", 1, payload) as ${n.className}UpdatedPayload;
  },
};
export const ${n.camel}DeletedEvent: EventDefinition<${n.className}DeletedPayload> = {
  name: "${deletedEventName}",
  schemaVersion: 1,
  parse(payload: unknown): ${n.className}DeletedPayload {
    return applicationEventCatalog.parse("${deletedEventName}", 1, payload) as ${n.className}DeletedPayload;
  },
};

// Runs only for the committed event, scoped to its tenant: use context.data for tenant reads and writes. Keep external side effects idempotent.
export async function handle${n.className}Created(payload: ${n.className}CreatedPayload, envelope: EventEnvelope, _environment: unknown, context: EventHandlerContext): Promise<void> {
  context.log.info("resource.${n.kebab}.created.consumed", {
    resourceId: payload.resourceId, eventId: envelope.id, organizationId: context.organizationId,
  });
}
export async function handle${n.className}Updated(payload: ${n.className}UpdatedPayload, envelope: EventEnvelope, _environment: unknown, context: EventHandlerContext): Promise<void> {
  context.log.info("resource.${n.kebab}.updated.consumed", {
    resourceId: payload.resourceId, revision: payload.revision, eventId: envelope.id, organizationId: context.organizationId,
  });
}
export async function handle${n.className}Deleted(payload: ${n.className}DeletedPayload, envelope: EventEnvelope, _environment: unknown, context: EventHandlerContext): Promise<void> {
  context.log.info("resource.${n.kebab}.deleted.consumed", {
    resourceId: payload.resourceId, revision: payload.revision, eventId: envelope.id, organizationId: context.organizationId,
  });
}
`);

  if (emitsChangeEvents) await writeGenerated(targets[11]!, `import { ${n.camel}, createDatabase, createTenantDatabase } from "@${project}/db";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Postgres${n.className}Repository } from "./${n.kebab}-repository.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite("${n.className} change-event atomicity", () => {
  it("rolls back update and delete when the event cannot be recorded", async () => {
    const organizationId = "event-" + crypto.randomUUID();
    const admin = createDatabase(connectionString!, "postgres-js");
    const tenant = createTenantDatabase(connectionString!, "postgres-js", organizationId);
    const repository = new Postgres${n.className}Repository(tenant, organizationId, {
      statement: () => sql\`select 1 / 0\`,
    });
    const rows = await admin.insert(${n.camel}).values([
      { organizationId, name: "Update original" },
      { organizationId, name: "Delete original" },
    ]).returning();
    const updateId = rows[0]!.id;
    const deleteId = rows[1]!.id;
    try {
      await expect(repository.update(updateId, { name: "Update changed" })).rejects.toThrow("select 1 / 0");
      const [unchanged] = await admin.select().from(${n.camel}).where(eq(${n.camel}.id, updateId));
      expect(unchanged).toMatchObject({ name: "Update original", revision: 1 });
      await expect(repository.remove(deleteId)).rejects.toThrow("select 1 / 0");
      const [undeleted] = await admin.select().from(${n.camel}).where(eq(${n.camel}.id, deleteId));
      expect(undeleted).toMatchObject({ name: "Delete original", revision: 1 });
    } finally {
      await admin.delete(${n.camel}).where(eq(${n.camel}.organizationId, organizationId));
    }
  });
});
`);

  if (!hasDefinition) {
    const publicProjection = (kind: "created" | "updated" | "deleted") => {
      if (!webhookEvents.includes(kind)) return "";
      const hasRevision = kind !== "created";
      const payload = hasRevision ? "{ resourceId: z.uuid(), revision: z.number().int().positive() }" : "{ resourceId: z.uuid() }";
      const sample = `{ resourceId: "00000000-0000-4000-8000-000000000001"${hasRevision ? ", revision: 1" : ""} }`;
      const projected = `{ resourceId: payload.resourceId${hasRevision ? ", revision: payload.revision" : ""} }`;
      return `  webhook: {
    type: "resource.${n.snake}.${kind}", version: 1,
    description: "The ${n.className} resource was ${kind}.",
    payload: z.object(${payload}).strict(),
    project: (payload: { resourceId: string${hasRevision ? "; revision: number" : ""} }) => (${projected}),
    sensitivity: { classification: "customer", retentionClass: "standard" },
    examples: [${sample}],
    fixtures: [{ internal: ${sample}, public: ${sample} }],
  },
`;
    };
    const definitions = `export const ${eventSymbols[0]} = defineEvent({
  name: "${eventName}", schemaVersion: 1,
  description: "A ${n.className} resource was created.", sensitivity: "internal",
  payload: z.object({ resourceId: z.uuid() }),
  resource: { type: "${n.snake}", id: (payload: { resourceId: string }) => payload.resourceId },
${publicProjection("created")}
});
export const ${eventSymbols[1]} = defineEvent({
  name: "${updatedEventName}", schemaVersion: 1,
  description: "A ${n.className} resource was updated.", sensitivity: "internal",
  payload: z.object({ resourceId: z.uuid(), revision: z.number().int().positive() }),
  resource: { type: "${n.snake}", id: (payload: { resourceId: string }) => payload.resourceId },
${publicProjection("updated")}
});
export const ${eventSymbols[2]} = defineEvent({
  name: "${deletedEventName}", schemaVersion: 1,
  description: "A ${n.className} resource was deleted.", sensitivity: "internal",
  payload: z.object({ resourceId: z.uuid(), revision: z.number().int().positive() }),
  resource: { type: "${n.snake}", id: (payload: { resourceId: string }) => payload.resourceId },
${publicProjection("deleted")}
});\n`;
    const updatedCatalog = catalogSource
      .replace("// trestle:resource-event-definitions", `${definitions}// trestle:resource-event-definitions`)
      .replace("  // trestle:resource-event-list", `  ${eventSymbols.join(",\n  ")},\n  // trestle:resource-event-list`);
    await writeFile(catalogPath, updatedCatalog, "utf8");
  }

  if (webhookEvents.length) await writeGenerated(targets[12]!, `import { describe, expect, it } from "vitest";
import { applicationEventCatalog } from "../application-catalog.js";

describe("${n.className} public webhook contract", () => {
  const resourceId = "00000000-0000-4000-8000-000000000001";
  const selected = ${JSON.stringify(webhookEvents)};

  it("exposes only the explicitly selected, versioned events", () => {
    expect(applicationEventCatalog.publicEvents()
      .filter((event) => event.type.startsWith("resource.${n.snake}."))
      .map((event) => [event.type, event.version]))
      .toEqual(selected.map((kind) => ["resource.${n.snake}." + kind, 1]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
    for (const kind of ["created", "updated", "deleted"] as const) {
      const payload = kind === "created" ? { resourceId } : { resourceId, revision: 1 };
      const projection = applicationEventCatalog.project("resource.${n.snake}." + kind, 1, payload);
      if (selected.includes(kind)) {
        expect(projection).toMatchObject({ type: "resource.${n.snake}." + kind, version: 1, resource: { type: "${n.snake}", id: resourceId }, data: payload });
      } else expect(projection).toBeNull();
    }
  });
});
`);

  await writeGenerated(targets[7]!, `import { describe, expect, it } from "vitest";
import { ${n.camel}CreateSchema, ${n.camel}UpdateSchema } from "./${n.kebab}.js";

describe("${n.className} contracts", () => {
  it("validates create and update boundaries", () => {
    const valid = { ${resource.fields.filter(({ required }) => required).map((field) => `${field.name}: ${exampleExpression(field)}`).join(", ")} };
    expect(${n.camel}CreateSchema.parse(valid)).toMatchObject(valid);
    expect(() => ${n.camel}CreateSchema.parse({ name: "" })).toThrow();
    expect(() => ${n.camel}UpdateSchema.parse({})).toThrow();
  });
});
`);

  await writeGenerated(targets[8]!, `import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const prefix = \`${n.kebab}-rls-\${Date.now()}-\`;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;

suite("${n.className} forced tenant isolation", () => {
  beforeAll(async () => { await sql!\`insert into ${n.snake} (organization_id, name) values ('org-a', \${\`${"${prefix}"}a\`}), ('org-b', \${\`${"${prefix}"}b\`})\`; });
  afterAll(async () => { await sql!\`delete from ${n.snake} where name like \${\`${"${prefix}"}%\`}\`; await sql!.end(); });
  it("fails closed and blocks cross-tenant reads and writes", async () => {
    await sql!.begin(async (transaction) => {
      await transaction\`set local role trestle_app\`;
      expect(await transaction\`select id from ${n.snake} where name like \${\`${"${prefix}"}%\`}\`).toHaveLength(0);
      await transaction\`select set_config('app.organization_id', 'org-a', true)\`;
      expect((await transaction\`select organization_id from ${n.snake} where name like \${\`${"${prefix}"}%\`}\`).map((row) => row.organization_id)).toEqual(["org-a"]);
      expect((await transaction\`update ${n.snake} set name = 'forbidden' where organization_id = 'org-b'\`).count).toBe(0);
      expect((await transaction\`delete from ${n.snake} where organization_id = 'org-b'\`).count).toBe(0);
    });
  });
${relations.slice(0, 1).map((field) => relationIntegrationTest(n, field)).join("")}});
`);

  await appendExport(path.join(root, contractsPath, "src", "index.ts"), `export * from "./resources/${n.kebab}.js";`);
  await appendExport(path.join(root, domainPath, "src", "index.ts"), `export * from "./resources/${n.kebab}.js";`);
  await appendExport(path.join(root, dataPath, "src", "index.ts"), `export * from "./resources/${n.kebab}-repository.js";`);
  await appendExport(path.join(root, dbPath, "src", "index.ts"), `export * from "./${n.kebab}-schema.js";`);
  const workerIndex = path.join(root, workerPath, "src", "index.ts");
  let workerSource = await readFile(workerIndex, "utf8");
  const workerImport = `import { ${n.camel}Routes } from "./resources/${n.kebab}-routes.js";`;
  if (!workerSource.includes(workerImport)) workerSource = `${workerImport}\n${workerSource}`;
  const workerEventImport = emitsChangeEvents
    ? `import { ${n.camel}CreatedEvent, ${n.camel}UpdatedEvent, ${n.camel}DeletedEvent, handle${n.className}Created, handle${n.className}Updated, handle${n.className}Deleted } from "./resources/${n.kebab}-events.js";`
    : `import { ${n.camel}CreatedEvent, handle${n.className}Created } from "./resources/${n.kebab}-events.js";`;
  if (!workerSource.includes(workerEventImport)) workerSource = `${workerEventImport}\n${workerSource}`;
  const workerRegistration = `app.route("/", ${n.camel}Routes);`;
  // Generated handlers declare tenant authority. Any existing registration of the same event,
  // including the undeclared form earlier generators wrote, counts as already registered.
  const workerEventRegistration = (emitsChangeEvents ? ["Created", "Updated", "Deleted"] : ["Created"])
    .filter((kind) => !workerSource.includes(`eventConsumers.register(${n.camel}${kind}Event, `))
    .map((kind) => `eventConsumers.register(${n.camel}${kind}Event, handle${n.className}${kind}, { authority: "tenant" });`)
    .join("\n");
  const workerAnchor = ["\nconst consumeQueue =", "\ntype WorkerEnvironment =", "\nexport default {", "\nexport default app;"].find((candidate) => workerSource.includes(candidate));
  if (!workerAnchor) throw new Error("Worker entrypoint has no supported resource registration anchor");
  if (!workerSource.includes(workerRegistration)) {
    workerSource = workerSource.replace(workerAnchor, `\n${workerRegistration}\n${workerAnchor}`);
  }
  if (workerEventRegistration) {
    workerSource = workerSource.replace(workerAnchor, `\n${workerEventRegistration}\n${workerAnchor}`);
  }
  await writeFile(workerIndex, workerSource, "utf8");

  const appIndex = path.join(root, appPath, "src", "main.tsx");
  let appSource = await readFile(appIndex, "utf8");
  const appImport = `import { ${n.className}Screen } from "./resources/${n.kebab}.js";`;
  if (!appSource.includes(appImport)) appSource = `${appImport}\n${appSource}`;
  const routeDeclaration = `const ${n.camel}Route = createRoute({ getParentRoute: () => rootRoute, path: "/${n.pluralKebab}", component: ${n.className}Screen });`;
  if (!appSource.includes(routeDeclaration)) appSource = appSource.replace(
    "const routeTree = rootRoute.addChildren([",
    `${routeDeclaration}\nconst routeTree = rootRoute.addChildren([${n.camel}Route, `,
  );
  const navigationLink = `<Link to="/${n.pluralKebab}" activeProps={{ className: "text-brand-500" }}>${n.className}</Link>`;
  if (!appSource.includes(navigationLink)) appSource = appSource.replace(
    "        {/* trestle:resource-links */}",
    `        ${navigationLink}\n        {/* trestle:resource-links */}`,
  );
  await writeFile(appIndex, appSource, "utf8");

  return created;
}

export type GeneratedMigration = { migrationPath: string; files: string[] };

/** Runs the project's db:generate and returns the single migration it created, with its new metadata files. */
export async function runDatabaseGenerate(root: string, manifest: ProjectManifest): Promise<GeneratedMigration | undefined> {
  const dbPath = manifest.packages.db ?? "packages/db";
  const packagePath = path.join(root, dbPath, "package.json");
  if (!(await exists(packagePath))) return undefined;
  const migrationDirectory = path.join(root, dbPath, "migrations");
  const before = new Set((await readdir(migrationDirectory)).filter((entry) => entry.endsWith(".sql")));
  const metaDirectory = path.join(migrationDirectory, "meta");
  const metaBefore = new Set(await readdir(metaDirectory));
  const databaseUrl = process.env.DATABASE_URL ?? `postgres://trestle:trestle@localhost:55432/${manifest.project.name.replace(/-/gu, "_")}`;
  try {
    await runCommand("pnpm", ["db:generate"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" });
  } catch (error) {
    throw new CliFailure(`unable to generate the Drizzle migration: ${error instanceof Error ? error.message : String(error)}`);
  }
  const created = (await readdir(migrationDirectory)).filter((entry) => entry.endsWith(".sql") && !before.has(entry));
  const metaCreated = (await readdir(metaDirectory)).filter((entry) => !metaBefore.has(entry));
  if (created.length !== 1) throw new CliFailure(`expected Drizzle to generate one migration, generated ${created.length}`);
  const migrationPath = path.join(migrationDirectory, created[0]!);
  return { migrationPath, files: [path.relative(root, migrationPath), ...metaCreated.map((entry) => path.relative(root, path.join(metaDirectory, entry)))] };
}

export function migrationStatements(sqlSource: string): string[] {
  return sqlSource.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
}

export function isTenantKeyStatement(statement: string): boolean {
  return /^ALTER TABLE "[^"]+" ADD CONSTRAINT "[^"]+" UNIQUE\("organization_id","id"\);$/u.test(statement);
}

/**
 * Drizzle adds foreign keys before unique constraints on existing tables, but a composite relation
 * needs its parent's tenant key first. Tenant keys added this way are always on existing tables.
 */
export function tenantKeysFirst(sqlSource: string): string {
  const statements = migrationStatements(sqlSource);
  const tenantKeys = statements.filter(isTenantKeyStatement);
  return tenantKeys.length ? `${[...tenantKeys, ...statements.filter((statement) => !tenantKeys.includes(statement))].join("--> statement-breakpoint\n")}\n` : sqlSource;
}

/** Drizzle cannot express a column list; without it SET NULL would also null organization_id. */
export function narrowSetNull(sqlSource: string, resource: ResourceNames, field: ResourceField): string {
  if (field.type !== "relation" || field.references?.onDelete !== "set-null") return sqlSource;
  return sqlSource.replace(new RegExp(`(CONSTRAINT "${relationKeyName(resource, field)}" FOREIGN KEY [^;]*? ON DELETE) set null`, "u"), `$1 SET NULL ("${columnName(field)}")`);
}

export async function generateResourceMigration(root: string, manifest: ProjectManifest, resources: SetupResource[]): Promise<string[]> {
  if (resources.length === 0) return [];
  const generated = await runDatabaseGenerate(root, manifest);
  if (!generated) return [];
  let sqlSource = tenantKeysFirst(await readFile(generated.migrationPath, "utf8"));
  for (const resource of resources) {
    for (const field of resource.fields) sqlSource = narrowSetNull(sqlSource, names(resource.name), field);
    const table = names(resource.name).snake;
    sqlSource = `${sqlSource.trimEnd()}\n--> statement-breakpoint\nALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;\n--> statement-breakpoint\nREVOKE ALL ON "${table}" FROM PUBLIC;\n--> statement-breakpoint\nGRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO trestle_app;\n`;
  }
  await writeFile(generated.migrationPath, sqlSource, "utf8");
  return generated.files;
}

export async function addResourceField(root: string, manifest: ProjectManifest, resourceName: string, field: ResourceField): Promise<string[]> {
  if (field.required) throw new CliFailure("migration-safe field additions must be optional; backfill data before making a field required");
  const n = names(resourceName);
  const declarationPath = path.join(root, ".trestle", "resources", `${n.kebab}.json`);
  const declaration = JSON.parse(await readFile(declarationPath, "utf8")) as SetupResource & { schemaVersion: number };
  if (declaration.schemaVersion !== 2 || !Array.isArray(declaration.fields)) throw new CliFailure(`resource ${resourceName} must be regenerated with a version 2 declaration before safe edits`);
  if (declaration.fields.some(({ name }) => name === field.name)) throw new CliFailure(`resource ${resourceName} already has field ${field.name}`);
  const contractsPath = path.join(root, manifest.packages.contracts ?? "packages/contracts", "src", "resources", `${n.kebab}.ts`);
  const schemaPath = path.join(root, manifest.packages.db ?? "packages/db", "src", `${n.kebab}-schema.ts`);
  let contracts = await readFile(contractsPath, "utf8");
  const contractAnchor = "});\nexport const";
  if (!contracts.includes(contractAnchor)) throw new CliFailure("resource contract does not contain the managed field anchor");
  contracts = contracts.replace(contractAnchor, `  ${field.name}: ${zodExpression(field)},\n});\nexport const`);
  const responseAnchor = "  id: z.string().uuid(),";
  if (!contracts.includes(responseAnchor)) throw new CliFailure("resource response contract does not contain the managed field anchor");
  contracts = contracts.replace(responseAnchor, `  ${field.name}: ${zodExpression({ ...field, required: true })}.nullable(),\n${responseAnchor}`);
  let schema = await readFile(schemaPath, "utf8");
  const schemaAnchor = "  createdAt: timestamp";
  if (!schema.includes(schemaAnchor)) throw new CliFailure("resource schema does not contain the managed field anchor");
  const changed: string[] = [];
  if (field.type === "relation") {
    const dbPath = manifest.packages.db ?? "packages/db";
    await assertRelationTargets(root, dbPath, resourceName, [field]);
    const related = names(field.references!.resource);
    const policyAnchor = `  pgPolicy("${n.snake}_tenant", {`;
    if (!schema.includes(policyAnchor)) throw new CliFailure("resource schema does not contain the managed tenant policy anchor");
    const parentSchema = path.join(root, dbPath, "src", `${related.kebab}-schema.ts`);
    if (await ensureTenantKey(parentSchema, related)) changed.push(path.relative(root, parentSchema));
    const importLine = `import { ${related.camel} } from "./${related.kebab}-schema.js";`;
    if (!schema.includes(importLine)) schema = schema.replace("\n\nexport const", `\n${importLine}\n\nexport const`);
    schema = withPgCoreImports(schema.replace(policyAnchor, `${relationKeyExpression(n, field)}\n${policyAnchor}`), ["foreignKey"]);
  }
  const check = fieldCheckExpression(n, field);
  if (check) {
    const policyAnchor = `  pgPolicy("${n.snake}_tenant", {`;
    if (!schema.includes(policyAnchor)) throw new CliFailure("resource schema does not contain the managed tenant policy anchor");
    schema = schema.replace(policyAnchor, `${check}\n${policyAnchor}`);
  }
  if (pgCoreImports([field]).length) schema = withPgCoreImports(schema, pgCoreImports([field]));
  if (field.type === "json") {
    const jsonValue = await ensureJsonValueType(path.dirname(schemaPath));
    if (jsonValue) changed.push(path.relative(root, jsonValue));
    if (!schema.includes(jsonValueImport)) schema = schema.replace(/(import \{[^}]*\} from "drizzle-orm\/pg-core";\n)/u, `$1${jsonValueImport}\n`);
  }
  schema = schema.replace(schemaAnchor, `  ${field.name}: ${columnExpression(field)},\n${schemaAnchor}`);
  await writeFile(contractsPath, contracts, "utf8");
  await writeFile(schemaPath, schema, "utf8");
  declaration.fields = [...declaration.fields, field];
  await writeFile(declarationPath, `${JSON.stringify(declaration, null, 2)}\n`, "utf8");
  return [path.relative(root, contractsPath), path.relative(root, schemaPath), ...changed, path.relative(root, declarationPath), ...await generateResourceMigration(root, manifest, [declaration])];
}
