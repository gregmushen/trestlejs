import { access, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectManifest } from "./core.js";

import {
  columnName, ensureTenantKey, isTenantKeyStatement, migrationStatements, names, narrowSetNull, relationKeyExpression, relationKeyName, runDatabaseGenerate, withPgCoreImports,
  type ResourceField,
} from "./generate-resource.js";
import { inspectResources } from "./inspect.js";
import { runCommand } from "./processes.js";
import { CliFailure } from "./runtime.js";

/**
 * Relations generated before tenant-safe composite keys (PR #186) reference the
 * parent by ID alone: `uuid(col).references(() => parent.id, …)`. This module
 * finds them, checks existing rows read-only, and moves them to the composite
 * (organization_id, <parent>_id) key the generator emits today.
 */
export type ResourceRelation = {
  resource: string;
  field: string;
  parent: string;
  table: string;
  column: string;
  parentTable: string;
  onDelete: "restrict" | "cascade" | "set-null";
  /** The tenant-safe composite foreign key name the generator uses. */
  constraint: string;
  /** The child schema, relative to the project root. */
  schema: string;
  definition: ResourceField;
  state: "legacy" | "composite" | "unrecognized";
};

export type RelationPreflightRow = { relation: string; missing_parents: number; cross_tenant: number };

function legacyReference(relation: Pick<ResourceRelation, "field" | "column" | "parent">): RegExp {
  const parent = names(relation.parent).camel;
  return new RegExp(`(\\b${relation.field}:\\s*uuid\\(\\s*"${relation.column}"\\s*\\))\\s*\\.references\\(\\s*\\(\\)\\s*=>\\s*${parent}\\.id\\s*(?:,\\s*\\{[^}]*\\})?\\s*\\)`, "u");
}

/** Every generated relation field and whether its schema is ID-only, composite, or unrecognized. */
export async function inspectResourceRelations(root: string, manifest: ProjectManifest): Promise<ResourceRelation[]> {
  const dbPath = manifest.packages.db ?? "packages/db";
  const relations: ResourceRelation[] = [];
  for (const declaration of await inspectResources(root)) {
    const fields = ((declaration as { fields?: ResourceField[] }).fields ?? []).filter((field) => field.type === "relation" && field.references);
    if (!fields.length) continue;
    const n = names(declaration.name);
    const schema = declaration.persistence?.schema ?? path.join(dbPath, "src", `${n.kebab}-schema.ts`);
    const source = await readFile(path.join(root, schema), "utf8").catch(() => undefined);
    if (source === undefined) continue; // doctor reports missing resource sources separately
    for (const field of fields) {
      const relation = {
        resource: declaration.name, field: field.name, parent: field.references!.resource,
        table: declaration.persistence?.table ?? n.snake, column: columnName(field), parentTable: names(field.references!.resource).snake,
        onDelete: field.references!.onDelete, constraint: relationKeyName(n, field), schema, definition: field,
      };
      const state = legacyReference(relation).test(source) ? "legacy" : source.includes(`"${relation.constraint}"`) ? "composite" : "unrecognized";
      relations.push({ ...relation, state });
    }
  }
  return relations;
}

/** Replaces one ID-only reference with the generated composite foreign key. */
export function rewriteLegacyRelation(source: string, relation: ResourceRelation): string {
  const pattern = legacyReference(relation);
  if (!pattern.test(source)) throw new CliFailure(`${relation.resource}.${relation.field} has no generated ID-only reference to rewrite in ${relation.schema}`);
  const n = names(relation.resource);
  const policyAnchor = `  pgPolicy("${n.snake}_tenant", {`;
  if (!source.includes(policyAnchor)) throw new CliFailure(`${relation.schema} does not contain the managed tenant policy anchor; add the composite foreign key by hand`);
  let rewritten = source.replace(pattern, "$1");
  if (!rewritten.includes(`"${relation.constraint}"`)) rewritten = rewritten.replace(policyAnchor, `${relationKeyExpression(n, relation.definition)}\n${policyAnchor}`);
  // The ID-only reference already imported the parent table; the composite key needs it too.
  const parent = names(relation.parent);
  if (!new RegExp(`import \\{[^}]*\\b${parent.camel}\\b[^}]*\\} from "\\./${parent.kebab}-schema\\.js";`, "u").test(rewritten)) {
    rewritten = rewritten.replace("\n\nexport const", `\nimport { ${parent.camel} } from "./${parent.kebab}-schema.js";\n\nexport const`);
  }
  return withPgCoreImports(rewritten, ["foreignKey"]);
}

/** Read-only counts, per relation, of rows that the composite key would reject. */
export function relationPreflightSql(relations: readonly ResourceRelation[]): string {
  return `${relations.map((relation) => `select '${relation.resource}.${relation.field}' as relation, count(*) filter (where parent.id is null)::int as missing_parents, count(*) filter (where parent.id is not null and parent.organization_id <> child.organization_id)::int as cross_tenant from "${relation.table}" child left join "${relation.parentTable}" parent on parent.id = child."${relation.column}" where child."${relation.column}" is not null`).join("\nunion all\n")};`;
}

/**
 * Orders Drizzle's output so a relation is never unprotected: parent tenant keys, then the
 * composite keys NOT VALID, then VALIDATE, and only then the ID-only drops. Anything else
 * in the migration means the schema had unrelated pending changes.
 */
export function stageRelationMigration(sqlSource: string, relations: readonly ResourceRelation[]): string {
  const statements = migrationStatements(sqlSource);
  const tenantKeys = statements.filter(isTenantKeyStatement);
  const tables = new Set(relations.map(({ table }) => table));
  const drops = statements.filter((statement) => {
    const match = /^ALTER TABLE "([^"]+)" DROP CONSTRAINT "[^"]+";$/u.exec(statement);
    return Boolean(match && tables.has(match[1]!));
  });
  const adds = relations.map((relation) => {
    const statement = statements.find((candidate) => candidate.startsWith(`ALTER TABLE "${relation.table}" ADD CONSTRAINT "${relation.constraint}" FOREIGN KEY `));
    if (!statement) throw new CliFailure(`the generated migration does not add ${relation.constraint}; review the schema rewrite`);
    return { relation, statement };
  });
  const unrelated = statements.filter((statement) => !tenantKeys.includes(statement) && !drops.includes(statement) && !adds.some((add) => add.statement === statement));
  if (unrelated.length) throw new CliFailure(`the generated migration also contains unrelated schema changes; generate and apply those first:\n${unrelated.join("\n")}`);
  if (drops.length !== relations.length) throw new CliFailure(`expected to drop ${relations.length} ID-only foreign keys, found ${drops.length}; review the schema rewrite`);
  const staged = adds.map(({ relation, statement }) => narrowSetNull(statement, names(relation.resource), relation.definition).replace(/;$/u, " NOT VALID;"));
  const validations = adds.map(({ relation }) => `ALTER TABLE "${relation.table}" VALIDATE CONSTRAINT "${relation.constraint}";`);
  return `${[...tenantKeys, ...staged, ...validations, ...drops].join("\n--> statement-breakpoint\n")}\n`;
}

const preflightScript = `
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  const [role] = await sql\`select rolsuper or rolbypassrls as bypass from pg_roles where rolname = current_user\`;
  const rows = await sql.begin("read only", (transaction) => transaction.unsafe(process.env.TRESTLE_RELATION_PREFLIGHT_SQL));
  console.log(JSON.stringify({ bypass: Boolean(role && role.bypass), rows: [...rows] }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
} finally {
  await sql.end({ timeout: 5 });
}
`;

/** Runs the preflight in a read-only transaction with the project's own PostgreSQL driver. */
export async function runRelationPreflight(root: string, manifest: ProjectManifest, connection: string, statement: string): Promise<RelationPreflightRow[]> {
  const result = await runCommand(process.execPath, ["--input-type=module", "-e", preflightScript], {
    cwd: path.join(root, manifest.packages.db ?? "packages/db"),
    env: { ...process.env, DATABASE_URL: connection, TRESTLE_RELATION_PREFLIGHT_SQL: statement },
    stdio: "pipe",
  }).catch((error: unknown) => { throw new CliFailure(`relation preflight could not run: ${error instanceof Error ? error.message.trim().split("\n").at(-1) : String(error)}`); });
  const output = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as { error?: string; bypass?: boolean; rows?: RelationPreflightRow[] };
  if (output.error) throw new CliFailure(`relation preflight failed: ${output.error}; apply pending migrations and check the connection before retrying`);
  // Generated tables force row-level security, so a role without BYPASSRLS would count only the rows it can see.
  if (!output.bypass) throw new CliFailure("relation preflight needs a role that bypasses row-level security (superuser or BYPASSRLS); generated tables force RLS, so any other role would undercount. Set DATABASE_MIGRATION_URL to an owner or operator role that bypasses RLS");
  return output.rows ?? [];
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false);
}

/**
 * Rewrites child schemas to composite keys, gives parents a tenant key, then generates
 * and stages the migration. Restores every file if any step fails.
 */
export async function migrateLegacyRelations(root: string, manifest: ProjectManifest, relations: readonly ResourceRelation[]): Promise<string[]> {
  const dbPath = manifest.packages.db ?? "packages/db";
  const migrationDirectory = path.join(root, dbPath, "migrations");
  const metaDirectory = path.join(migrationDirectory, "meta");
  const parentSchemas = [...new Set(relations.map(({ parent }) => parent))].map((parent) => ({ parent, schema: path.join(root, dbPath, "src", `${names(parent).kebab}-schema.ts`) }));
  for (const { parent, schema } of parentSchemas) {
    if (!(await exists(schema))) throw new CliFailure(`${parent} schema ${path.relative(root, schema)} is missing; restore it before migrating relations`);
  }
  const touched = [...new Set([...relations.map(({ schema }) => path.join(root, schema)), ...parentSchemas.map(({ schema }) => schema), path.join(metaDirectory, "_journal.json")])];
  const originals = new Map(await Promise.all(touched.map(async (file) => [file, await readFile(file, "utf8")] as const)));
  const listing = async () => new Set([...(await readdir(migrationDirectory)).map((entry) => path.join(migrationDirectory, entry)), ...(await readdir(metaDirectory)).map((entry) => path.join(metaDirectory, entry))]);
  const before = await listing();
  try {
    const changed = new Set<string>();
    for (const relation of relations) {
      const schemaPath = path.join(root, relation.schema);
      await writeFile(schemaPath, rewriteLegacyRelation(await readFile(schemaPath, "utf8"), relation), "utf8");
      changed.add(relation.schema);
    }
    for (const { parent, schema } of parentSchemas) {
      if (await ensureTenantKey(schema, names(parent))) changed.add(path.relative(root, schema));
    }
    const generated = await runDatabaseGenerate(root, manifest);
    if (!generated) throw new CliFailure(`${dbPath}/package.json is missing; cannot generate the constraint migration`);
    await writeFile(generated.migrationPath, stageRelationMigration(await readFile(generated.migrationPath, "utf8"), relations), "utf8");
    return [...changed, ...generated.files];
  } catch (error) {
    for (const entry of await listing()) if (!before.has(entry)) await rm(entry, { force: true, recursive: true });
    for (const [file, source] of originals) await writeFile(file, source, "utf8");
    throw error;
  }
}
