// End-to-end adoption proof for P1 (docs/PLATFORM_HARDENING_SPEC.md §2) against real PostgreSQL:
// a generated project whose relations still use the pre-#186 ID-only foreign keys moves to
// tenant-safe composite keys with `trestle resource migrate-relations`, without losing data.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adminUrl = process.env.TRESTLE_GENERATED_DATABASE_URL;
if (!adminUrl) throw new Error("TRESTLE_GENERATED_DATABASE_URL must name a disposable PostgreSQL server (superuser) for the legacy relation check");
const cli = path.join(root, "packages/cli/dist/bin.js");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "trestle-legacy-relations-"));
const project = path.join(temporaryRoot, "legacy-relations");
const suffix = randomBytes(4).toString("hex");
const databases = [`trestle_legacy_${suffix}`, `trestle_legacy_invalid_${suffix}`];
const databaseUrl = (name) => { const url = new URL(adminUrl); url.pathname = `/${name}`; return url.toString(); };
const [primaryUrl, invalidUrl] = databases.map(databaseUrl);

async function run(command, arguments_, cwd, extraEnvironment = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnvironment } });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} ${arguments_.join(" ")} failed (${signal ?? `exit ${code}`})`)));
  });
}

function trestle(arguments_, input) {
  const result = spawnSync(process.execPath, [cli, ...arguments_], { cwd: project, encoding: "utf8", input });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Runs SQL with the generated project's own driver; `role`/`organization` simulate the restricted runtime. */
function query(url, statement, { role, organization } = {}) {
  const script = `import postgres from "postgres";
const sql = postgres(process.env.Q_URL, { max: 1, onnotice: () => {} });
try {
  const rows = !process.env.Q_ROLE && !process.env.Q_ORG ? await sql.unsafe(process.env.Q_SQL) : await sql.begin(async (tx) => {
    if (process.env.Q_ROLE) await tx.unsafe("set local role " + process.env.Q_ROLE);
    if (process.env.Q_ORG) await tx\`select set_config('app.organization_id', \${process.env.Q_ORG}, true)\`;
    return tx.unsafe(process.env.Q_SQL);
  });
  console.log(JSON.stringify({ rows: [...rows] }));
} catch (error) { console.log(JSON.stringify({ error: error.message })); } finally { await sql.end({ timeout: 5 }); }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: path.join(project, "packages", "db"), encoding: "utf8", env: { ...process.env, Q_URL: url, Q_SQL: statement, Q_ROLE: role ?? "", Q_ORG: organization ?? "" } });
  if (result.status !== 0) throw new Error(`query helper failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}
function rows(url, statement, options) {
  const result = query(url, statement, options);
  if (result.error) throw new Error(`${statement}: ${result.error}`);
  return result.rows;
}
function expect(condition, message) { if (!condition) throw new Error(message); }

const migrationsPath = path.join(project, "packages", "db", "migrations");
const journalPath = path.join(migrationsPath, "meta", "_journal.json");
const sqlFiles = async () => (await readdir(migrationsPath)).filter((name) => name.endsWith(".sql")).sort();
async function sourceState() {
  const files = ["packages/db/src/author-schema.ts", "packages/db/src/article-schema.ts", "packages/db/migrations/meta/_journal.json"];
  return JSON.stringify({ sources: await Promise.all(files.map((file) => readFile(path.join(project, file), "utf8"))), migrations: await sqlFiles(), meta: (await readdir(path.join(migrationsPath, "meta"))).sort() });
}

try {
  if (!process.env.TRESTLE_LEGACY_CLI_ARCHIVE) await run("pnpm", ["build"], root);
  await run(process.execPath, [path.join(root, "packages/create/dist/bin.js"), project, "--no-git", "--no-install"], root);
  const manifestPath = path.join(project, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.devDependencies.trestlejs = process.env.TRESTLE_LEGACY_CLI_ARCHIVE ? `file:${process.env.TRESTLE_LEGACY_CLI_ARCHIVE}` : `link:${path.join(root, "packages/cli")}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await run("pnpm", ["install"], project);
  for (const name of databases) rows(adminUrl, `create database "${name}"`);

  // 1. Generate Author and Article(authorId set-null, editorId restrict), then rewrite them to the
  //    pre-#186 output: ID-only `.references(() => author.id)`, no tenant keys, one migration.
  const journalBefore = JSON.parse(await readFile(journalPath, "utf8"));
  const metaBefore = new Set(await readdir(path.join(migrationsPath, "meta")));
  const sqlBefore = new Set(await sqlFiles());
  await run(process.execPath, [cli, "generate", "resource", "Author"], project);
  await run(process.execPath, [cli, "generate", "resource", "Article", "--field", "summary:text?", "authorId:relation?:Author:set-null", "editorId:relation?:Author:restrict"], project);
  for (const file of await sqlFiles()) if (!sqlBefore.has(file)) await rm(path.join(migrationsPath, file));
  for (const file of await readdir(path.join(migrationsPath, "meta"))) if (!metaBefore.has(file)) await rm(path.join(migrationsPath, "meta", file));
  await writeFile(journalPath, `${JSON.stringify(journalBefore, null, 2)}\n`);
  const legacyImports = 'import { boolean, index, integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";';
  const authorPath = path.join(project, "packages/db/src/author-schema.ts");
  const articlePath = path.join(project, "packages/db/src/article-schema.ts");
  let author = await readFile(authorPath, "utf8");
  author = author.replace(/import \{[^}]*\} from "drizzle-orm\/pg-core";/u, legacyImports).replace('  unique("author_tenant_key").on(table.organizationId, table.id),\n', "");
  let article = await readFile(articlePath, "utf8");
  article = article.replace(/import \{[^}]*\} from "drizzle-orm\/pg-core";/u, legacyImports)
    .replace('  unique("article_tenant_key").on(table.organizationId, table.id),\n', "")
    .replace(/ {2}foreignKey\(\{[^\n]*\n/gu, "")
    .replace('authorId: uuid("author_id"),', 'authorId: uuid("author_id").references(() => author.id, { onDelete: "set null" }),')
    .replace('editorId: uuid("editor_id"),', 'editorId: uuid("editor_id").references(() => author.id, { onDelete: "restrict" }),');
  expect(!author.includes("tenant_key") && !article.includes("tenant_") && article.includes(".references(() => author.id"), "legacy schema rewrite did not apply");
  await writeFile(authorPath, author);
  await writeFile(articlePath, article);
  await run("pnpm", ["db:generate"], project, { DATABASE_URL: primaryUrl });
  const [legacyMigration] = (await sqlFiles()).filter((file) => !sqlBefore.has(file));
  const legacyPath = path.join(migrationsPath, legacyMigration);
  let legacySql = await readFile(legacyPath, "utf8");
  expect(legacySql.includes('FOREIGN KEY ("author_id") REFERENCES "public"."author"("id") ON DELETE set null'), `legacy migration is not ID-only:\n${legacySql}`);
  for (const table of ["author", "article"]) legacySql = `${legacySql.trimEnd()}\n--> statement-breakpoint\nALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;\n--> statement-breakpoint\nREVOKE ALL ON "${table}" FROM PUBLIC;\n--> statement-breakpoint\nGRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO trestle_app;\n`;
  await writeFile(legacyPath, legacySql);
  for (const url of [primaryUrl, invalidUrl]) await run("pnpm", ["db:migrate"], project, { DATABASE_URL: url });

  // 2. Existing data, and the gap: the restricted runtime can link org-a's article to org-b's author.
  const [a1] = rows(primaryUrl, "insert into author (organization_id, name) values ('org-a', 'Ada') returning id");
  const [b1] = rows(primaryUrl, "insert into author (organization_id, name) values ('org-b', 'Bea') returning id");
  rows(primaryUrl, `insert into article (organization_id, name, author_id, editor_id) values ('org-a', 'a-linked', '${a1.id}', '${a1.id}'), ('org-a', 'a-unlinked', null, null), ('org-b', 'b-linked', '${b1.id}', null)`);
  const [crossTenant] = rows(primaryUrl, `insert into article (organization_id, name, author_id) values ('org-a', 'a-cross', '${b1.id}') returning id`, { role: "trestle_app", organization: "org-a" });
  const snapshot = () => JSON.stringify(rows(primaryUrl, "select id, organization_id, name, author_id, editor_id from article order by name"));
  const before = snapshot();

  // 3. doctor flags the ID-only relation and points at the command.
  const setSecret = trestle(["secrets", "set", "DATABASE_URL", "--env", "local"], primaryUrl);
  expect(setSecret.status === 0, `could not set the local DATABASE_URL: ${setSecret.output}`);
  const doctor = spawnSync(process.execPath, [cli, "doctor", "--json"], { cwd: project, encoding: "utf8" });
  const relationCheck = JSON.parse(doctor.stdout).data.checks.find((check) => check.id === "resources.article.relations.tenant_safe");
  expect(relationCheck?.status === "fail" && relationCheck.remediation.includes("trestle resource migrate-relations") && relationCheck.evidence.includes("Article.authorId") && relationCheck.evidence.includes("Article.editorId"), `doctor did not flag the ID-only relations: ${JSON.stringify(relationCheck)}`);

  // 4. With a cross-tenant link present, the dry run reports it and --yes refuses before writing anything.
  const sourcesBefore = await sourceState();
  const dirty = trestle(["resource", "migrate-relations"]);
  console.log(`--- migrate-relations dry run with a cross-tenant link ---\n${dirty.output}`);
  expect(dirty.status === 1 && dirty.output.includes("Article.authorId: cross-tenant=1 missing-parent=0") && dirty.output.includes("never repairs, reassigns or deletes"), `dry run did not report the cross-tenant link:\n${dirty.output}`);
  const refused = trestle(["resource", "migrate-relations", "--yes"]);
  expect(refused.status === 1 && refused.output.includes("Nothing was written"), `--yes did not refuse invalid rows:\n${refused.output}`);
  expect(await sourceState() === sourcesBefore, "refused migrate-relations changed project files");
  expect(snapshot() === before, "the preflight changed data");

  // 5. The operator detaches the link (their decision), and the preflight is clean.
  rows(primaryUrl, `update article set author_id = null where id = '${crossTenant.id}'`);
  const detached = snapshot();
  const clean = trestle(["resource", "migrate-relations"]);
  expect(clean.status === 0 && clean.output.includes("Article.authorId: cross-tenant=0 missing-parent=0") && clean.output.includes("Article.editorId: cross-tenant=0 missing-parent=0") && clean.output.includes("Dry run; nothing was written"), `clean dry run failed:\n${clean.output}`);
  expect(await sourceState() === sourcesBefore, "dry run changed project files");

  // 6. --yes rewrites the schemas and stages the migration: tenant keys, NOT VALID, VALIDATE, then drops.
  const applied = trestle(["resource", "migrate-relations", "--yes"]);
  console.log(`--- migrate-relations --yes after the preflight is clean ---\n${applied.output}`);
  expect(applied.status === 0 && applied.output.includes("Migrated 2 relation(s)"), `migrate-relations --yes failed:\n${applied.output}`);
  const [relationMigration] = (await sqlFiles()).filter((file) => file !== legacyMigration && !sqlBefore.has(file));
  const staged = (await readFile(path.join(migrationsPath, relationMigration), "utf8")).split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
  const position = (pattern) => staged.findIndex((statement) => pattern.test(statement));
  expect(position(/"author_tenant_key" UNIQUE/u) === 0, `tenant key is not first:\n${staged.join("\n")}`);
  expect(staged.some((statement) => /"article_author_id_tenant_fk" FOREIGN KEY \("organization_id","author_id"\).* ON DELETE SET NULL \("author_id"\) .*NOT VALID;$/u.test(statement)), `set-null composite key is not narrowed and NOT VALID:\n${staged.join("\n")}`);
  expect(position(/VALIDATE CONSTRAINT "article_editor_id_tenant_fk"/u) > position(/ADD CONSTRAINT "article_editor_id_tenant_fk"/u), "VALIDATE precedes ADD");
  expect(position(/DROP CONSTRAINT "article_author_id_author_id_fk"/u) > position(/VALIDATE CONSTRAINT "article_author_id_tenant_fk"/u), "the ID-only key is dropped before the composite key is validated");
  expect(staged.length === 7, `unexpected statements in the relation migration:\n${staged.join("\n")}`);
  const redoctor = JSON.parse(spawnSync(process.execPath, [cli, "doctor", "--json"], { cwd: project, encoding: "utf8" }).stdout).data.checks.find((check) => check.id === "resources.article.relations.tenant_safe");
  expect(redoctor?.status === "pass", `doctor still fails after migrate-relations: ${JSON.stringify(redoctor)}`);
  expect(trestle(["resource", "migrate-relations"]).output.includes("All generated relations use tenant-safe composite keys"), "migrate-relations is not idempotent");
  const migrationsAfter = await sqlFiles();
  await run("pnpm", ["db:generate"], project, { DATABASE_URL: primaryUrl });
  expect(JSON.stringify(await sqlFiles()) === JSON.stringify(migrationsAfter), "schema and snapshot disagree: db:generate created another migration");

  // 7. On a database that still holds a cross-tenant link, the migration fails and rolls back.
  const [ib] = rows(invalidUrl, "insert into author (organization_id, name) values ('org-b', 'Bea') returning id");
  rows(invalidUrl, `insert into article (organization_id, name, author_id) values ('org-a', 'a-cross', '${ib.id}')`);
  let failed = false;
  await run("pnpm", ["db:migrate"], project, { DATABASE_URL: invalidUrl }).catch(() => { failed = true; });
  expect(failed, "the constraint migration applied over a cross-tenant link");
  const invalidConstraints = rows(invalidUrl, "select conname from pg_constraint where conrelid = 'article'::regclass and contype = 'f' order by conname").map(({ conname }) => conname);
  expect(JSON.stringify(invalidConstraints) === JSON.stringify(["article_author_id_author_id_fk", "article_editor_id_author_id_fk"]), `failed migration did not roll back: ${invalidConstraints}`);
  expect(rows(invalidUrl, "select count(*)::int as count from pg_constraint where conname = 'author_tenant_key'")[0].count === 0, "failed migration left the parent tenant key behind");
  expect(rows(invalidUrl, "select count(*)::int as count from article")[0].count === 1, "failed migration changed data");
  // The only obstacle was the cross-tenant row: once the operator detaches it, the same migration applies.
  rows(invalidUrl, "update article set author_id = null");
  await run("pnpm", ["db:migrate"], project, { DATABASE_URL: invalidUrl });

  // 8. Apply on the clean database: data survives, the ID-only keys are gone, and the runtime role is held to its tenant.
  await run("pnpm", ["db:migrate"], project, { DATABASE_URL: primaryUrl });
  expect(snapshot() === detached, "existing rows changed during the constraint migration");
  const constraints = rows(primaryUrl, "select conname, convalidated from pg_constraint where conrelid = 'article'::regclass and contype = 'f' order by conname");
  expect(JSON.stringify(constraints) === JSON.stringify([{ conname: "article_author_id_tenant_fk", convalidated: true }, { conname: "article_editor_id_tenant_fk", convalidated: true }]), `unexpected foreign keys: ${JSON.stringify(constraints)}`);
  const runtime = { role: "trestle_app", organization: "org-a" };
  const crossInsert = query(primaryUrl, `insert into article (organization_id, name, author_id) values ('org-a', 'a-cross-2', '${b1.id}')`, runtime);
  expect(/article_author_id_tenant_fk/u.test(crossInsert.error ?? ""), `cross-tenant insert was not rejected: ${JSON.stringify(crossInsert)}`);
  const crossUpdate = query(primaryUrl, `update article set editor_id = '${b1.id}' where name = 'a-unlinked'`, runtime);
  expect(/article_editor_id_tenant_fk/u.test(crossUpdate.error ?? ""), `cross-tenant update was not rejected: ${JSON.stringify(crossUpdate)}`);
  const missingParent = query(primaryUrl, "insert into article (organization_id, name, author_id) values ('org-a', 'a-missing', '00000000-0000-4000-8000-000000000009')", runtime);
  expect(/article_author_id_tenant_fk/u.test(missingParent.error ?? ""), "missing parent was not rejected");
  rows(primaryUrl, `insert into article (organization_id, name, author_id) values ('org-a', 'a-same', '${a1.id}')`, runtime);
  rows(primaryUrl, "update article set author_id = null where name = 'a-same'", runtime);
  const restrictDelete = query(primaryUrl, `delete from author where id = '${a1.id}'`);
  expect(/article_editor_id_tenant_fk/u.test(restrictDelete.error ?? ""), `restrict delete was not enforced: ${JSON.stringify(restrictDelete)}`);
  rows(primaryUrl, `delete from author where id = '${b1.id}'`);
  const [nulled] = rows(primaryUrl, "select organization_id, author_id from article where name = 'b-linked'");
  expect(nulled.organization_id === "org-b" && nulled.author_id === null, `set-null delete changed tenant identity: ${JSON.stringify(nulled)}`);
  console.log("Legacy relation migration check passed");
} finally {
  for (const name of databases) { try { query(adminUrl, `drop database if exists "${name}" with (force)`); } catch { /* best effort */ } }
  if (process.env.TRESTLE_KEEP_GENERATED === "1") console.log(`Retained legacy relation project at ${project}`);
  else await rm(temporaryRoot, { recursive: true, force: true });
}
