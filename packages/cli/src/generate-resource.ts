import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectManifest, SetupResource } from "@trestlejs/core";

import { runCommand } from "./processes.js";
import { CliFailure } from "./runtime.js";

type ResourceNames = {
  className: string;
  camel: string;
  kebab: string;
  snake: string;
  pluralKebab: string;
};

type ResourceField = SetupResource["fields"][number];

export function parseResourceField(value: string): ResourceField {
  const [name, type = "string", reference, onDelete = "restrict"] = value.split(":");
  const required = !type.endsWith("?");
  const normalizedType = type.replace(/\?$/u, "") as ResourceField["type"];
  if (!name || !/^[a-z][A-Za-z0-9]*$/u.test(name) || !["string", "text", "integer", "boolean", "datetime", "relation"].includes(normalizedType)) throw new CliFailure(`invalid field ${value}; expected name:type[?] or name:relation:Resource[:onDelete]`);
  if (normalizedType === "relation") {
    if (!reference || !/^[A-Z][A-Za-z0-9]*$/u.test(reference) || !["restrict", "cascade", "set-null"].includes(onDelete)) throw new CliFailure(`invalid relationship field ${value}`);
    if (required) throw new CliFailure("relationship fields must initially be optional; use name:relation?:Resource:onDelete");
    return { name, type: normalizedType, required, references: { resource: reference, onDelete: onDelete as "restrict" | "cascade" | "set-null" } };
  }
  if (reference) throw new CliFailure(`non-relation field ${name} cannot reference ${reference}`);
  return { name, type: normalizedType, required };
}

function zodExpression(field: ResourceField): string {
  const base = field.type === "string" ? "z.string().trim().min(1).max(200)" : field.type === "text" ? "z.string().max(10000)" : field.type === "integer" ? "z.number().int()" : field.type === "boolean" ? "z.boolean()" : field.type === "datetime" ? "z.coerce.date()" : "z.string().uuid()";
  return field.required ? base : `${base}.optional()`;
}

function columnExpression(field: ResourceField): string {
  const column = field.name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
  const base = field.type === "integer" ? `integer("${column}")` : field.type === "boolean" ? `boolean("${column}")` : field.type === "datetime" ? `timestamp("${column}", { withTimezone: true })` : field.type === "relation" ? `uuid("${column}").references(() => ${names(field.references!.resource).camel}.id, { onDelete: "${field.references!.onDelete === "set-null" ? "set null" : field.references!.onDelete}" })` : `text("${column}")`;
  return field.required ? `${base}.notNull()` : base;
}

function exampleExpression(field: ResourceField): string {
  if (field.type === "integer") return "42";
  if (field.type === "boolean") return "true";
  if (field.type === "datetime") return '"2026-01-01T00:00:00.000Z"';
  if (field.type === "relation") return '"00000000-0000-4000-8000-000000000001"';
  return `"${field.name === "name" ? "Example" : "Example value"}"`;
}

function names(name: string): ResourceNames {
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

async function appendExport(target: string, exportLine: string): Promise<void> {
  const source = await readFile(target, "utf8");
  if (source.includes(exportLine)) return;
  await writeFile(target, `${source.trimEnd()}\n${exportLine}\n`, "utf8");
}

export async function generateResource(root: string, manifest: ProjectManifest, resource: SetupResource): Promise<string[]> {
  if (!resource.tenant || !resource.crud) throw new CliFailure("the v1 resource generator requires --tenant and --crud");
  const n = names(resource.name);
  const project = manifest.project.name;
  const contractsPath = manifest.packages.contracts ?? "packages/contracts";
  const domainPath = manifest.packages.domain ?? "packages/domain";
  const dataPath = manifest.packages.data ?? "packages/data";
  const dbPath = manifest.packages.db ?? "packages/db";
  const workerPath = manifest.apps.worker ?? "apps/worker";
  const appPath = manifest.apps.app ?? "apps/app";
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
  ];
  const declarationExists = await exists(declarationPath);
  const collisions = (await Promise.all(targets.map(async (target) => (await exists(target) ? target : undefined)))).filter((target): target is string => Boolean(target));
  if (collisions.length && !declarationExists) throw new CliFailure(`resource ${resource.name} collides with existing files: ${collisions.join(", ")}`);
  if (declarationExists) {
    const current = JSON.parse(await readFile(declarationPath, "utf8")) as { name?: string; tenant?: boolean; crud?: boolean; fields?: unknown; authorization?: unknown; pagination?: unknown };
    const intended = { fields: resource.fields, authorization: resource.authorization ?? { read: "resource:read", write: "resource:write" }, pagination: resource.pagination };
    if (current.name !== resource.name || current.tenant !== resource.tenant || current.crud !== resource.crud || JSON.stringify({ fields: current.fields, authorization: current.authorization, pagination: current.pagination }) !== JSON.stringify(intended)) {
      throw new CliFailure(`resource ${resource.name} already exists with a different declaration`);
    }
  }

  for (const target of targets) await mkdir(path.dirname(target), { recursive: true });
  const created: string[] = [];
  const writeGenerated = async (target: string, source: string) => {
    if (await exists(target)) return;
    await writeFile(target, source, "utf8");
    created.push(path.relative(root, target));
  };
  const routePath = `/api/${n.pluralKebab}`;
  const readPermission = resource.authorization?.read ?? "resource:read";
  const writePermission = resource.authorization?.write ?? "resource:write";

  const declaration = {
    schemaVersion: 2,
    name: resource.name,
    tenant: resource.tenant,
    crud: resource.crud,
    fields: resource.fields,
    authorization: { read: readPermission, write: writePermission },
    pagination: resource.pagination,
    persistence: { table: n.snake, schema: path.relative(root, targets[4]!) },
    contracts: path.relative(root, targets[1]!),
    files: targets.slice(1).map((target) => path.relative(root, target)),
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
import { and, asc, eq, gt } from "drizzle-orm";

export class Postgres${n.className}Repository implements ${n.className}Repository {
  constructor(private readonly database: Database, private readonly organizationId: string) {}
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
    const [record] = await this.database.insert(${n.camel}).values({ ...input, organizationId: this.organizationId }).returning();
    if (!record) throw new Error("Failed to create ${n.className}");
    return record;
  }
  async update(id: string, input: Update${n.className}): Promise<${n.className} | null> {
    const [record] = await this.database.update(${n.camel}).set({ ...input, updatedAt: new Date() }).where(and(eq(${n.camel}.id, id), eq(${n.camel}.organizationId, this.organizationId))).returning();
    return record ?? null;
  }
  async remove(id: string): Promise<boolean> {
    return (await this.database.delete(${n.camel}).where(and(eq(${n.camel}.id, id), eq(${n.camel}.organizationId, this.organizationId))).returning()).length > 0;
  }
}
`);

  await writeGenerated(targets[4]!, `import { sql } from "drizzle-orm";
import { boolean, index, integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
${[...new Set(resource.fields.filter((field) => field.type === "relation").map((field) => field.references!.resource))].map((related) => `import { ${names(related).camel} } from "./${names(related).kebab}-schema.js";`).join("\n")}

export const ${n.camel} = pgTable("${n.snake}", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
${resource.fields.map((field) => `  ${field.name}: ${columnExpression(field)},`).join("\n")}
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("${n.snake}_organization_idx").on(table.organizationId),
  pgPolicy("${n.snake}_tenant", {
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
  return new ${n.className}Service(new Postgres${n.className}Repository(execution.data, execution.tenant.organizationId));
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
  execution.access.require({ plane: "organization", permission: "${readPermission}" });
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
  execution.access.require({ plane: "organization", permission: "${writePermission}" });
  return context.json({ ${n.camel}: await operation(execution, "resource.${n.kebab}.create", () => service(execution).create(parsed.data)) }, 201);
});
${n.camel}Routes.get("${routePath}/:id", async (context) => {
  const execution = context.get("execution");
  execution.access.require({ plane: "organization", permission: "${readPermission}" });
  const record = await operation(execution, "resource.${n.kebab}.read", () => service(execution).get(context.req.param("id")));
  return record ? context.json({ ${n.camel}: record }) : context.json({ error: "Not found" }, 404);
});
${n.camel}Routes.patch("${routePath}/:id", async (context) => {
  const parsed = ${n.camel}UpdateSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  const execution = context.get("execution");
  execution.access.require({ plane: "organization", permission: "${writePermission}" });
  const updated = await operation(execution, "resource.${n.kebab}.update", () => service(execution).update(context.req.param("id"), parsed.data));
  return updated ? context.json({ ${n.camel}: updated }) : context.json({ error: "Not found" }, 404);
});
${n.camel}Routes.delete("${routePath}/:id", async (context) => {
  const execution = context.get("execution");
  execution.access.require({ plane: "organization", permission: "${writePermission}" });
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
  const activeOrganization = authClient.useActiveOrganization();
  const organizationId = activeOrganization.data?.id;
  const api = organizationId ? create${n.className}Api(organizationId) : undefined;
  const queryClient = useQueryClient();
  const key = ["${n.pluralKebab}", organizationId] as const;
  const [editing, setEditing] = useState<${n.className} | null>(null);
  const [editingName, setEditingName] = useState("");
  const query = useQuery({
    queryKey: key,
    enabled: Boolean(organizationId),
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
  if (!organizationId) return <section className="card p-8"><h1 className="text-3xl font-semibold">${n.className}</h1><p className="mt-4 text-slate-600">Select an organization before managing ${n.pluralKebab}.</p></section>;
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
});
`);

  await appendExport(path.join(root, contractsPath, "src", "index.ts"), `export * from "./resources/${n.kebab}.js";`);
  await appendExport(path.join(root, domainPath, "src", "index.ts"), `export * from "./resources/${n.kebab}.js";`);
  await appendExport(path.join(root, dataPath, "src", "index.ts"), `export * from "./resources/${n.kebab}-repository.js";`);
  await appendExport(path.join(root, dbPath, "src", "index.ts"), `export * from "./${n.kebab}-schema.js";`);
  const workerIndex = path.join(root, workerPath, "src", "index.ts");
  let workerSource = await readFile(workerIndex, "utf8");
  const workerImport = `import { ${n.camel}Routes } from "./resources/${n.kebab}-routes.js";`;
  if (!workerSource.includes(workerImport)) workerSource = `${workerImport}\n${workerSource}`;
  const workerRegistration = `app.route("/", ${n.camel}Routes);`;
  if (!workerSource.includes(workerRegistration)) {
    const anchor = workerSource.includes("\nconst consumeQueue =") ? "\nconst consumeQueue =" : "\nexport default app;";
    workerSource = workerSource.replace(anchor, `\n${workerRegistration}\n${anchor}`);
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

export async function generateResourceMigration(root: string, manifest: ProjectManifest, resources: SetupResource[]): Promise<string[]> {
  if (resources.length === 0) return [];
  const dbPath = manifest.packages.db ?? "packages/db";
  const packagePath = path.join(root, dbPath, "package.json");
  if (!(await exists(packagePath))) return [];
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
  if (created.length !== 1) throw new CliFailure(`expected Drizzle to generate one migration, generated ${created.length}`);
  const migrationPath = path.join(migrationDirectory, created[0]!);
  let sqlSource = await readFile(migrationPath, "utf8");
  for (const resource of resources) {
    const table = names(resource.name).snake;
    sqlSource = `${sqlSource.trimEnd()}\n--> statement-breakpoint\nALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;\n--> statement-breakpoint\nREVOKE ALL ON "${table}" FROM PUBLIC;\n--> statement-breakpoint\nGRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO trestle_app;\n`;
  }
  await writeFile(migrationPath, sqlSource, "utf8");
  const metaCreated = (await readdir(metaDirectory)).filter((entry) => !metaBefore.has(entry));
  return [path.relative(root, migrationPath), ...metaCreated.map((entry) => path.relative(root, path.join(metaDirectory, entry)))];
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
  if (field.type === "relation") {
    const related = names(field.references!.resource);
    const importLine = `import { ${related.camel} } from "./${related.kebab}-schema.js";`;
    if (!schema.includes(importLine)) schema = schema.replace("\n\nexport const", `\n${importLine}\n\nexport const`);
  }
  schema = schema.replace(schemaAnchor, `  ${field.name}: ${columnExpression(field)},\n${schemaAnchor}`);
  await writeFile(contractsPath, contracts, "utf8");
  await writeFile(schemaPath, schema, "utf8");
  declaration.fields = [...declaration.fields, field];
  await writeFile(declarationPath, `${JSON.stringify(declaration, null, 2)}\n`, "utf8");
  return [path.relative(root, contractsPath), path.relative(root, schemaPath), path.relative(root, declarationPath), ...await generateResourceMigration(root, manifest, [declaration])];
}
