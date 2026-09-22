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
  ];
  const collisions = (await Promise.all(targets.map(async (target) => (await exists(target) ? target : undefined)))).filter(Boolean);
  if (collisions.length) throw new CliFailure(`resource ${resource.name} already exists: ${collisions.join(", ")}`);

  for (const target of targets) await mkdir(path.dirname(target), { recursive: true });
  const routePath = `/api/${n.pluralKebab}`;

  const declaration = {
    schemaVersion: 1,
    name: resource.name,
    tenant: resource.tenant,
    crud: resource.crud,
    persistence: { table: n.snake, schema: path.relative(root, targets[4]!) },
    contracts: path.relative(root, targets[1]!),
    routes: resource.crud ? [
      { method: "GET", path: routePath, auth: true },
      { method: "POST", path: routePath, auth: true },
      { method: "GET", path: `${routePath}/:id`, auth: true },
      { method: "PATCH", path: `${routePath}/:id`, auth: true },
      { method: "DELETE", path: `${routePath}/:id`, auth: true },
    ] : [],
  };
  await writeFile(declarationPath, `${JSON.stringify(declaration, null, 2)}\n`, "utf8");

  await writeFile(targets[1]!, `import { z } from "zod";

export const ${n.camel}CreateSchema = z.object({ name: z.string().trim().min(1).max(200) });
export const ${n.camel}UpdateSchema = ${n.camel}CreateSchema.partial().refine((value) => Object.keys(value).length > 0, "at least one field is required");
export const ${n.camel}Schema = ${n.camel}CreateSchema.extend({
  id: z.string().uuid(),
  organizationId: z.string().min(1),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ${n.className} = z.infer<typeof ${n.camel}Schema>;
export type Create${n.className} = z.infer<typeof ${n.camel}CreateSchema>;
export type Update${n.className} = z.infer<typeof ${n.camel}UpdateSchema>;
`, "utf8");

  await writeFile(targets[2]!, `export interface ${n.className}Repository<Record, Create, Update> {
  list(organizationId: string): Promise<Record[]>;
  get(organizationId: string, id: string): Promise<Record | null>;
  create(organizationId: string, input: Create): Promise<Record>;
  update(organizationId: string, id: string, input: Update): Promise<Record | null>;
  remove(organizationId: string, id: string): Promise<boolean>;
}

export class ${n.className}Service<Record, Create, Update> {
  constructor(private readonly repository: ${n.className}Repository<Record, Create, Update>) {}
  list(organizationId: string) { return this.repository.list(organizationId); }
  get(organizationId: string, id: string) { return this.repository.get(organizationId, id); }
  create(organizationId: string, input: Create) { return this.repository.create(organizationId, input); }
  update(organizationId: string, id: string, input: Update) { return this.repository.update(organizationId, id, input); }
  remove(organizationId: string, id: string) { return this.repository.remove(organizationId, id); }
}
`, "utf8");

  await writeFile(targets[3]!, `export type ${n.className}Record = { id: string; organizationId: string; name: string; createdAt: Date; updatedAt: Date };
export type ${n.className}Create = { name: string };
export type ${n.className}Update = Partial<${n.className}Create>;

export interface ${n.className}Repository {
  list(organizationId: string): Promise<${n.className}Record[]>;
  get(organizationId: string, id: string): Promise<${n.className}Record | null>;
  create(organizationId: string, input: ${n.className}Create): Promise<${n.className}Record>;
  update(organizationId: string, id: string, input: ${n.className}Update): Promise<${n.className}Record | null>;
  remove(organizationId: string, id: string): Promise<boolean>;
}
`, "utf8");

  await writeFile(targets[4]!, `import { sql } from "drizzle-orm";
import { index, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const ${n.camel} = pgTable("${n.snake}", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
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
`, "utf8");

  await writeFile(targets[5]!, `import { ${n.camel}CreateSchema, ${n.camel}UpdateSchema } from "@${project}/contracts";
import { createAuth, type AuthEnvironment } from "@${project}/auth";
import { ${n.camel}, createDatabase } from "@${project}/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

export const ${n.camel}Routes = new Hono<{ Bindings: AuthEnvironment }>();
async function organizationId(headers: Headers, environment: AuthEnvironment) {
  const session = await createAuth(environment).api.getSession({ headers });
  return session?.session.activeOrganizationId;
}
function tenantDatabase(environment: AuthEnvironment, tenant: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(tenant)) throw new Error("Invalid organization identifier");
  const url = new URL(environment.DATABASE_URL);
  const existing = url.searchParams.get("options");
  url.searchParams.set("options", [existing, "-c app.organization_id=" + tenant].filter(Boolean).join(" "));
  return createDatabase(url.toString(), environment.DATABASE_DRIVER);
}
${n.camel}Routes.get("${routePath}", async (context) => {
  const tenant = await organizationId(context.req.raw.headers, context.env);
  if (!tenant) return context.json({ error: "An active organization is required" }, 401);
  return context.json({ ${n.camel}s: await tenantDatabase(context.env, tenant).select().from(${n.camel}).where(eq(${n.camel}.organizationId, tenant)) });
});
${n.camel}Routes.post("${routePath}", async (context) => {
  const tenant = await organizationId(context.req.raw.headers, context.env);
  if (!tenant) return context.json({ error: "An active organization is required" }, 401);
  const input = ${n.camel}CreateSchema.parse(await context.req.json());
  const [created] = await tenantDatabase(context.env, tenant).insert(${n.camel}).values({ ...input, organizationId: tenant }).returning();
  return context.json({ ${n.camel}: created }, 201);
});
${n.camel}Routes.get("${routePath}/:id", async (context) => {
  const tenant = await organizationId(context.req.raw.headers, context.env);
  if (!tenant) return context.json({ error: "An active organization is required" }, 401);
  const [record] = await tenantDatabase(context.env, tenant).select().from(${n.camel}).where(and(eq(${n.camel}.id, context.req.param("id")), eq(${n.camel}.organizationId, tenant))).limit(1);
  return record ? context.json({ ${n.camel}: record }) : context.json({ error: "Not found" }, 404);
});
${n.camel}Routes.patch("${routePath}/:id", async (context) => {
  const tenant = await organizationId(context.req.raw.headers, context.env);
  if (!tenant) return context.json({ error: "An active organization is required" }, 401);
  const input = ${n.camel}UpdateSchema.parse(await context.req.json());
  const [updated] = await tenantDatabase(context.env, tenant).update(${n.camel}).set({ ...input, updatedAt: new Date() }).where(and(eq(${n.camel}.id, context.req.param("id")), eq(${n.camel}.organizationId, tenant))).returning();
  return updated ? context.json({ ${n.camel}: updated }) : context.json({ error: "Not found" }, 404);
});
${n.camel}Routes.delete("${routePath}/:id", async (context) => {
  const tenant = await organizationId(context.req.raw.headers, context.env);
  if (!tenant) return context.json({ error: "An active organization is required" }, 401);
  const removed = await tenantDatabase(context.env, tenant).delete(${n.camel}).where(and(eq(${n.camel}.id, context.req.param("id")), eq(${n.camel}.organizationId, tenant))).returning();
  return removed.length ? context.body(null, 204) : context.json({ error: "Not found" }, 404);
});
`, "utf8");

  await writeFile(targets[6]!, `import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { ${n.camel}CreateSchema, type ${n.className} } from "@${project}/contracts";

const apiOrigin = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\\\/$/u, "") ?? "";
export function ${n.className}Screen() {
  const query = useQuery({ queryKey: ["${n.pluralKebab}"], queryFn: async () => (await fetch(\`${"${apiOrigin}"}${routePath}\`, { credentials: "include" })).json() as Promise<{ ${n.camel}s: ${n.className}[] }> });
  const form = useForm({ defaultValues: { name: "" }, onSubmit: async ({ value }) => { const input = ${n.camel}CreateSchema.parse(value); await fetch(\`${"${apiOrigin}"}${routePath}\`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); await query.refetch(); } });
  return <section className="card p-8"><h1 className="text-3xl font-semibold">${n.className}</h1><form className="mt-6 flex gap-3" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}><form.Field name="name">{(field) => <input aria-label="Name" className="min-w-0 flex-1 rounded-xl border px-4 py-3" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} />}</form.Field><button className="button" type="submit">Create</button></form><ul className="mt-6 space-y-2">{query.data?.${n.camel}s.map((record) => <li className="rounded-xl border p-4" key={record.id}>{record.name}</li>)}</ul></section>;
}
`, "utf8");

  await writeFile(targets[7]!, `import { describe, expect, it } from "vitest";
import { ${n.camel}CreateSchema, ${n.camel}UpdateSchema } from "./${n.kebab}.js";

describe("${n.className} contracts", () => {
  it("validates create and update boundaries", () => {
    expect(${n.camel}CreateSchema.parse({ name: "Example" })).toEqual({ name: "Example" });
    expect(() => ${n.camel}CreateSchema.parse({ name: "" })).toThrow();
    expect(() => ${n.camel}UpdateSchema.parse({})).toThrow();
  });
});
`, "utf8");

  await writeFile(targets[8]!, `import postgres from "postgres";
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
`, "utf8");

  await appendExport(path.join(root, contractsPath, "src", "index.ts"), `export * from "./resources/${n.kebab}.js";`);
  await appendExport(path.join(root, domainPath, "src", "index.ts"), `export * from "./resources/${n.kebab}.js";`);
  await appendExport(path.join(root, dataPath, "src", "index.ts"), `export * from "./resources/${n.kebab}-repository.js";`);
  await appendExport(path.join(root, dbPath, "src", "index.ts"), `export * from "./${n.kebab}-schema.js";`);
  const workerIndex = path.join(root, workerPath, "src", "index.ts");
  let workerSource = await readFile(workerIndex, "utf8");
  workerSource = `import { ${n.camel}Routes } from "./resources/${n.kebab}-routes.js";\n${workerSource}`;
  workerSource = workerSource.replace("\nexport default app;", `\napp.route("/", ${n.camel}Routes);\n\nexport default app;`);
  await writeFile(workerIndex, workerSource, "utf8");

  const appIndex = path.join(root, appPath, "src", "main.tsx");
  let appSource = await readFile(appIndex, "utf8");
  appSource = `import { ${n.className}Screen } from "./resources/${n.kebab}.js";\n${appSource}`;
  appSource = appSource.replace(
    "const routeTree = rootRoute.addChildren([",
    `const ${n.camel}Route = createRoute({ getParentRoute: () => rootRoute, path: "/${n.pluralKebab}", component: ${n.className}Screen });\nconst routeTree = rootRoute.addChildren([${n.camel}Route, `,
  );
  await writeFile(appIndex, appSource, "utf8");

  return targets.map((target) => path.relative(root, target));
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
