import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProjectManifest } from "../src/core.js";
import { runDoctor } from "../src/doctor.js";
import { executeCli } from "../src/index.js";
import { inspectResourceRelations, relationPreflightSql, rewriteLegacyRelation, stageRelationMigration } from "../src/legacy-relations.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

/** The schema `trestle generate resource` wrote before tenant-safe composite keys (PR #186). */
function legacySchema(table: string, symbol: string, fields: string, parents: Array<{ symbol: string; file: string }> = []): string {
  return `import { sql } from "drizzle-orm";
import { boolean, index, integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
${parents.map((parent) => `import { ${parent.symbol} } from "./${parent.file}-schema.js";`).join("\n")}

export const ${symbol} = pgTable("${table}", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
${fields}
  revision: integer("revision").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("${table}_organization_idx").on(table.organizationId),
  pgPolicy("${table}_tenant", {
    for: "all",
    to: "trestle_app",
    using: sql\`\${table.organizationId} = current_setting('app.organization_id', true)\`,
    withCheck: sql\`\${table.organizationId} = current_setting('app.organization_id', true)\`,
  }),
]).enableRLS();
`;
}

const legacyArticle = legacySchema("article", "article", `  name: text("name").notNull(),
  summary: text("summary"),
  authorId: uuid("author_id").references(() => author.id, { onDelete: "set null" }),
  reviewerId: uuid("reviewer_id").references(() => author.id, { onDelete: "restrict" }),`, [{ symbol: "author", file: "author" }]);

async function legacyProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-legacy-relations-"));
  directories.push(root);
  await mkdir(path.join(root, ".trestle", "resources"), { recursive: true });
  await mkdir(path.join(root, "packages", "db", "src"), { recursive: true });
  const declaration = (name: string, fields: unknown[]) => JSON.stringify({ schemaVersion: 2, name, tenant: true, crud: true, fields, persistence: { table: name.toLowerCase(), schema: `packages/db/src/${name.toLowerCase()}-schema.ts` } }, null, 2);
  await writeFile(path.join(root, ".trestle", "resources", "author.json"), declaration("Author", [{ name: "name", type: "string", required: true }]));
  await writeFile(path.join(root, ".trestle", "resources", "article.json"), declaration("Article", [
    { name: "name", type: "string", required: true },
    { name: "summary", type: "text", required: false },
    { name: "authorId", type: "relation", required: false, references: { resource: "Author", onDelete: "set-null" } },
    { name: "reviewerId", type: "relation", required: false, references: { resource: "Author", onDelete: "restrict" } },
  ]));
  await writeFile(path.join(root, "packages", "db", "src", "author-schema.ts"), legacySchema("author", "author", '  name: text("name").notNull(),'));
  await writeFile(path.join(root, "packages", "db", "src", "article-schema.ts"), legacyArticle);
  return root;
}

const manifestFor = async () => ({ ...(await loadProjectManifest(path.resolve("packages/create/template"))), packages: { db: "packages/db" } });

describe("legacy ID-only relation detection", () => {
  it("finds relations whose schema still references the parent by ID alone", async () => {
    const root = await legacyProject();
    const relations = await inspectResourceRelations(root, await manifestFor());
    expect(relations).toEqual([
      expect.objectContaining({ resource: "Article", field: "authorId", parent: "Author", table: "article", column: "author_id", parentTable: "author", onDelete: "set-null", constraint: "article_author_id_tenant_fk", schema: "packages/db/src/article-schema.ts", state: "legacy" }),
      expect.objectContaining({ resource: "Article", field: "reviewerId", column: "reviewer_id", onDelete: "restrict", constraint: "article_reviewer_id_tenant_fk", state: "legacy" }),
    ]);
  });

  it("treats a rewritten schema as tenant-safe and an unrecognized one as unverified", async () => {
    const root = await legacyProject();
    const relations = await inspectResourceRelations(root, await manifestFor());
    const rewritten = relations.reduce((source, relation) => rewriteLegacyRelation(source, relation), legacyArticle);
    await writeFile(path.join(root, "packages", "db", "src", "article-schema.ts"), rewritten);
    expect((await inspectResourceRelations(root, await manifestFor())).map(({ state }) => state)).toEqual(["composite", "composite"]);
    await writeFile(path.join(root, "packages", "db", "src", "article-schema.ts"), legacyArticle.replace(/\.references\([^)]*\)[^)]*\)/gu, ""));
    expect((await inspectResourceRelations(root, await manifestFor())).map(({ state }) => state)).toEqual(["unrecognized", "unrecognized"]);
  });

  it("fails doctor with a pointer to the adoption command", async () => {
    const root = await legacyProject();
    const report = await runDoctor(root, await manifestFor(), "local");
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "resources.article.relations.tenant_safe", status: "fail",
      evidence: expect.stringContaining("Article.authorId"),
      remediation: expect.stringContaining("trestle resource migrate-relations"),
    }));
    expect(report.checks.some((check) => check.id === "resources.author.relations.tenant_safe")).toBe(false);
  });
});

describe("legacy relation schema rewrite", () => {
  it("replaces the ID-only reference with the generated composite foreign key", async () => {
    const root = await legacyProject();
    const [authorId, reviewerId] = await inspectResourceRelations(root, await manifestFor());
    const rewritten = rewriteLegacyRelation(rewriteLegacyRelation(legacyArticle, authorId!), reviewerId!);
    expect(rewritten).not.toContain(".references(");
    expect(rewritten).toContain('  authorId: uuid("author_id"),\n');
    expect(rewritten).toContain('  reviewerId: uuid("reviewer_id"),\n');
    expect(rewritten).toContain('  foreignKey({ name: "article_author_id_tenant_fk", columns: [table.organizationId, table.authorId], foreignColumns: [author.organizationId, author.id] }).onDelete("set null"),\n  foreignKey({ name: "article_reviewer_id_tenant_fk", columns: [table.organizationId, table.reviewerId], foreignColumns: [author.organizationId, author.id] }).onDelete("restrict"),\n  pgPolicy("article_tenant", {');
    expect(rewritten).toContain('import { boolean, foreignKey, index, integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";');
    expect(() => rewriteLegacyRelation(rewritten, authorId!)).toThrow(/ID-only reference/u);
  });
});

describe("relation preflight", () => {
  it("counts cross-tenant links and missing parents for every relation without changing data", async () => {
    const root = await legacyProject();
    const statement = relationPreflightSql(await inspectResourceRelations(root, await manifestFor()));
    expect(statement).toContain(`select 'Article.authorId' as relation, count(*) filter (where parent.id is null)::int as missing_parents, count(*) filter (where parent.id is not null and parent.organization_id <> child.organization_id)::int as cross_tenant from "article" child left join "author" parent on parent.id = child."author_id" where child."author_id" is not null`);
    expect(statement).toContain("union all");
    expect(statement).not.toMatch(/\b(update|delete|insert|alter|drop)\b/iu);
  });
});

describe("relation constraint migration staging", () => {
  const breakpoint = "--> statement-breakpoint\n";
  const drizzleOutput = [
    'ALTER TABLE "article" DROP CONSTRAINT "article_author_id_author_id_fk";',
    'ALTER TABLE "article" DROP CONSTRAINT "article_reviewer_id_author_id_fk";',
    'ALTER TABLE "article" ADD CONSTRAINT "article_author_id_tenant_fk" FOREIGN KEY ("organization_id","author_id") REFERENCES "public"."author"("organization_id","id") ON DELETE set null ON UPDATE no action;',
    'ALTER TABLE "article" ADD CONSTRAINT "article_reviewer_id_tenant_fk" FOREIGN KEY ("organization_id","reviewer_id") REFERENCES "public"."author"("organization_id","id") ON DELETE restrict ON UPDATE no action;',
    'ALTER TABLE "author" ADD CONSTRAINT "author_tenant_key" UNIQUE("organization_id","id");',
  ].join(breakpoint);

  it("adds tenant keys, then NOT VALID composite keys, validates them, and only then drops the ID-only keys", async () => {
    const root = await legacyProject();
    const staged = stageRelationMigration(drizzleOutput, await inspectResourceRelations(root, await manifestFor()));
    expect(staged.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean)).toEqual([
      'ALTER TABLE "author" ADD CONSTRAINT "author_tenant_key" UNIQUE("organization_id","id");',
      'ALTER TABLE "article" ADD CONSTRAINT "article_author_id_tenant_fk" FOREIGN KEY ("organization_id","author_id") REFERENCES "public"."author"("organization_id","id") ON DELETE SET NULL ("author_id") ON UPDATE no action NOT VALID;',
      'ALTER TABLE "article" ADD CONSTRAINT "article_reviewer_id_tenant_fk" FOREIGN KEY ("organization_id","reviewer_id") REFERENCES "public"."author"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;',
      'ALTER TABLE "article" VALIDATE CONSTRAINT "article_author_id_tenant_fk";',
      'ALTER TABLE "article" VALIDATE CONSTRAINT "article_reviewer_id_tenant_fk";',
      'ALTER TABLE "article" DROP CONSTRAINT "article_author_id_author_id_fk";',
      'ALTER TABLE "article" DROP CONSTRAINT "article_reviewer_id_author_id_fk";',
    ]);
  });

  it("refuses a migration that carries unrelated schema changes or misses a relation", async () => {
    const relations = await inspectResourceRelations(await legacyProject(), await manifestFor());
    expect(() => stageRelationMigration(`${drizzleOutput}${breakpoint}ALTER TABLE "article" ADD COLUMN "extra" text;`, relations)).toThrow(/unrelated schema changes/u);
    expect(() => stageRelationMigration(drizzleOutput.split(breakpoint).slice(1).join(breakpoint), relations)).toThrow(/expected to drop 2 ID-only/u);
  });
});

describe("trestle resource migrate-relations", () => {
  function capture(root: string) {
    let stdout = ""; let stderr = "";
    return { runtime: { cwd: () => root, stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; }, stdin: async () => "", isTTY: () => false, environment: () => undefined }, stdout: () => stdout, stderr: () => stderr };
  }
  async function cliProject(): Promise<string> {
    const root = await legacyProject();
    await writeFile(path.join(root, ".trestle", "project.yaml"), `schemaVersion: 1
project:
  name: fixture
apps: {}
packages:
  db: packages/db
tenancy:
  model: organization
  enforcement: postgres-rls
database:
  engine: postgresql
  defaultProvider: neon
capabilities:
  r2: false
  queues: false
  workflows: false
  durableObjects: false
  admin: false
environments: [local, preview, staging, production]
`);
    return root;
  }

  it("is a stable, dry-run-by-default command that lists relations and prints the preflight without writing", async () => {
    const root = await cliProject();
    const before = await readFile(path.join(root, "packages", "db", "src", "article-schema.ts"), "utf8");
    const output = capture(root);
    expect(await executeCli(["resource", "migrate-relations"], output.runtime)).toBe(0);
    expect(output.stdout()).toContain("Article.authorId -> Author (article.author_id, on delete set-null)");
    expect(output.stdout()).toContain("Article.reviewerId -> Author (article.reviewer_id, on delete restrict)");
    expect(output.stdout()).toContain("select 'Article.authorId' as relation");
    expect(output.stdout()).toContain("No DATABASE_MIGRATION_URL or DATABASE_URL is configured for local");
    expect(output.stdout()).toContain("Dry run; nothing was written");
    expect(await readFile(path.join(root, "packages", "db", "src", "article-schema.ts"), "utf8")).toBe(before);
    expect(await readdir(path.join(root, "packages", "db", "src"))).toEqual(["article-schema.ts", "author-schema.ts"]);
  });

  it("reports nothing to do once every relation is composite", async () => {
    const root = await cliProject();
    const relations = await inspectResourceRelations(root, await manifestFor());
    await writeFile(path.join(root, "packages", "db", "src", "article-schema.ts"), relations.reduce((source, relation) => rewriteLegacyRelation(source, relation), legacyArticle));
    const output = capture(root);
    expect(await executeCli(["resource", "migrate-relations", "--yes"], output.runtime)).toBe(0);
    expect(output.stdout()).toContain("All generated relations use tenant-safe composite keys");
  });
});
