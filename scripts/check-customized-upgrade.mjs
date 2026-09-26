// Upgrades a customized project from the latest published release to this
// source tree (packed as the next version) using only supported commands:
// generated resources, application-owned edits, a framework file edited by
// both sides, and data in a real database must all survive, the framework's
// changes must be adopted, and a second plan must report nothing left to do.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const published = process.env.TRESTLE_CUSTOMIZED_UPGRADE_FROM ?? "0.1.0-beta.3";
const current = JSON.parse(await readFile(path.join(root, "packages/cli/package.json"), "utf8")).version;
const beta = /^0\.1\.0-beta\.(\d+)$/u.exec(published);
if (!beta) throw new Error("the customized upgrade rehearsal starts from a published beta");
const candidate = `0.1.0-beta.${Number(beta[1]) + 1}`;
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "trestle-customized-upgrade-"));
const project = path.join(temporaryRoot, "customized");
let maintenance;
let databaseName;

async function run(command, arguments_, cwd, extra = {}, expectFailure = false) {
  let output = "";
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...extra } });
    child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });
    child.once("error", reject);
    child.once("exit", (exit) => resolve(exit ?? 1));
  });
  if (expectFailure ? code === 0 : code !== 0) throw new Error(`${command} ${arguments_.join(" ")} ${expectFailure ? "unexpectedly succeeded" : `failed (exit ${code})`}`);
  return output;
}
const trestle = (arguments_, extra, expectFailure) => run("pnpm", ["exec", "trestle", ...arguments_], project, extra, expectFailure);
const read = (relative) => readFile(path.join(project, relative), "utf8");
const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  // The candidate is this tree's CLI, versioned as the release after the published one.
  await run("pnpm", ["build"], root);
  const staged = path.join(temporaryRoot, "candidate");
  await cp(path.join(root, "packages/cli"), staged, { recursive: true, filter: (source) => !source.includes(`${path.sep}node_modules`) });
  const manifest = JSON.parse(await readFile(path.join(staged, "package.json"), "utf8"));
  await writeFile(path.join(staged, "package.json"), `${JSON.stringify({ ...manifest, version: candidate }, null, 2)}\n`);
  const versionModule = path.join(staged, "dist", "version.js");
  await writeFile(versionModule, (await readFile(versionModule, "utf8")).replace(`"${current}"`, `"${candidate}"`));
  await run("npm", ["pack", "--pack-destination", temporaryRoot], staged);
  const archive = path.join(temporaryRoot, (await readdir(temporaryRoot)).find((name) => name.endsWith(".tgz")));

  // A published project, customized the way applications are.
  await run("pnpm", ["dlx", `create-trestlejs@${published}`, project, "--no-git", "--no-install"], root);
  await run("pnpm", ["install"], project);
  await trestle(["generate", "resource", "Article", "--field", "summary:text?"]);
  const domainPath = "packages/domain/src/resources/article.ts";
  const domainRule = "\n// Application-owned rule: summaries are reviewed before publication.\n";
  await writeFile(path.join(project, domainPath), `${await read(domainPath)}${domainRule}`);
  const readmeNote = "\n## Team notes\n\nApplication-owned documentation kept through upgrades.\n";
  await writeFile(path.join(project, "README.md"), `${await read("README.md")}${readmeNote}`);

  let databaseUrl;
  if (process.env.TRESTLE_ADJACENT_DATABASE_URL) {
    const postgres = createRequire(path.join(project, "package.json"))("postgres");
    const address = new URL(process.env.TRESTLE_ADJACENT_DATABASE_URL);
    address.pathname = "/postgres";
    maintenance = postgres(address.toString(), { max: 1 });
    databaseName = `trestle_customized_${randomBytes(6).toString("hex")}`;
    await maintenance.unsafe(`CREATE DATABASE "${databaseName}"`);
    address.pathname = `/${databaseName}`;
    databaseUrl = address.toString();
    await run("pnpm", ["db:migrate"], project, { DATABASE_URL: databaseUrl });
    const database = postgres(databaseUrl, { max: 1 });
    try { await database.unsafe("INSERT INTO article (organization_id, name, summary) VALUES ('org-upgrade', 'Kept through the upgrade', 'custom')"); }
    finally { await database.end(); }
  }

  await run("pnpm", ["add", "--workspace-root", "--save-dev", "--save-exact", `trestlejs@file:${archive}`], project);
  // The candidate is not on a registry. Record it as the registry pin a real upgrade
  // would produce; nothing reinstalls after this point.
  const packagePath = path.join(project, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.devDependencies.trestlejs = candidate;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const lockPath = path.join(project, "pnpm-lock.yaml");
  const lock = await readFile(lockPath, "utf8");
  const pinned = lock.replace(/(\n {6}trestlejs:\n {8}specifier: )[^\n]+(\n {8}version: )[^\n]+/u, `$1${candidate}$2${candidate}`);
  assert(pinned !== lock, "could not find the trestlejs importer entry in pnpm-lock.yaml");
  await writeFile(lockPath, pinned);
  const before = JSON.parse(await trestle(["upgrade", "diff", "--json"])).data;
  const classification = (relative) => before.entries.find((entry) => entry.path === relative)?.classification;
  assert(before.targetTemplateVersion === candidate, `candidate CLI reports ${before.targetTemplateVersion}`);
  assert(classification("README.md") === "modified", "a framework file edited by both sides must be classified modified");
  assert(classification("packages/domain/src/index.ts") === "kept", "an application-only edit to a framework file must be kept");

  // The diverged journal is refused with a repair, then rebased.
  const refused = await trestle(["upgrade", "source-apply", "--yes"], {}, true);
  assert(refused.includes("trestle upgrade migrations --rebase --yes"), "source-apply must point at the migration rebase");
  await trestle(["upgrade", "migrations", "--rebase", "--yes"]);
  const audit = JSON.parse(await trestle(["upgrade", "migrations", "--json"])).data;
  assert(audit.classification === "application-ahead", `after the rebase the journal is ${audit.classification}`);
  // Deployment and configuration files are applied only when named after review.
  const protectedPath = (relative) => relative === ".trestle/project.yaml" || relative === ".trestle/recovery.json" || relative.startsWith(".github/workflows/") || relative.startsWith("config/") || relative.endsWith("wrangler.jsonc");
  const review = JSON.parse(await trestle(["upgrade", "diff", "--json"])).data.entries
    .filter((entry) => protectedPath(entry.path) && ["unchanged", "modified", "new"].includes(entry.classification)).map((entry) => entry.path);
  const unreviewed = await trestle(["upgrade", "source-apply", "--yes"], {}, true);
  assert(review.every((relative) => unreviewed.includes(relative)) && unreviewed.includes("--accept"), "source-apply must name each deployment file and how to accept it");
  for (const relative of review) assert((await trestle(["upgrade", "diff", "--path", relative])).includes("+++ target/"), `no reviewable diff for ${relative}`);
  await trestle(["upgrade", "source-apply", "--yes", ...(review.length ? ["--accept", ...review] : [])]);
  assert((await read(domainPath)).endsWith(domainRule), "application-owned domain code changed");
  const readme = await read("README.md");
  assert(readme.includes(readmeNote.trim()) && readme.includes("### API contracts"), "README must keep the application's notes and adopt the framework's changes");

  if (databaseUrl) {
    const blocked = await run("pnpm", ["db:migrate"], project, { DATABASE_URL: databaseUrl }, true);
    assert(blocked.includes("--apply-skipped"), "db:migrate must refuse migrations Drizzle would skip");
    await run("pnpm", ["db:migrate", "--", "--apply-skipped"], project, { DATABASE_URL: databaseUrl });
    await run("pnpm", ["db:migrate"], project, { DATABASE_URL: databaseUrl });
    const postgres = createRequire(path.join(project, "package.json"))("postgres");
    const database = postgres(databaseUrl, { max: 1 });
    try {
      const [{ scheduler }] = await database.unsafe("SELECT to_regclass('scheduled_job') IS NOT NULL AS scheduler");
      const rows = await database.unsafe("SELECT name FROM article WHERE organization_id = 'org-upgrade'");
      assert(scheduler, "the framework's skipped migrations were not applied");
      assert(rows.length === 1, "application data changed during the upgrade");
    } finally { await database.end(); }
  }
  const migrationsBefore = (await readdir(path.join(project, "packages/db/migrations"))).length;
  await run("pnpm", ["db:generate"], project, { DATABASE_URL: databaseUrl ?? "postgres://postgres:postgres@localhost:5432/unused" });
  assert((await readdir(path.join(project, "packages/db/migrations"))).length === migrationsBefore, "rebased snapshots drifted from the schema: db:generate created a migration");

  await trestle(["upgrade", "source-finalize", "--yes"]);
  await trestle(["upgrade", "plan", "--check"]);
  const after = JSON.parse(await trestle(["upgrade", "diff", "--json"])).data;
  const leftover = after.entries.filter((entry) => !["same", "kept"].includes(entry.classification) && !entry.path.startsWith("packages/db/migrations/"));
  assert(after.sourceTemplateVersion === candidate && leftover.length === 0, `second plan is not clean: ${JSON.stringify(leftover)}`);
  assert((await read(domainPath)).endsWith(domainRule) && (await read("README.md")).includes(readmeNote.trim()), "application edits did not survive finalization");
  console.log(`Customized upgrade ${published} → ${candidate} passed: generated resource, application edits, a merged framework file${databaseUrl ? ", and database contents" : ""} preserved; framework changes adopted; second plan clean.`);
} finally {
  if (maintenance) {
    if (databaseName) await maintenance.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.end();
  }
  if (process.env.TRESTLE_KEEP_CUSTOMIZED_UPGRADE === "1") console.error(`Kept ${temporaryRoot}`);
  else await rm(temporaryRoot, { recursive: true, force: true });
}
