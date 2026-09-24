import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const current = JSON.parse(await readFile(path.join(root, "packages/cli/package.json"), "utf8")).version;
const match = /^0\.1\.0-alpha\.(\d+)$/u.exec(current);
if (!match || Number(match[1]) < 3) throw new Error("Adjacent upgrade rehearsal requires an alpha release with two published predecessors");

// During a release candidate's CI, the candidate is not yet on npm. Rehearse
// the two latest published versions through their real create and upgrade CLIs.
const before = `0.1.0-alpha.${Number(match[1]) - 2}`;
const after = `0.1.0-alpha.${Number(match[1]) - 1}`;
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "trestle-adjacent-upgrade-"));
const project = path.join(temporaryRoot, "upgrade-canary");
let maintenance;
let upgradeDatabaseName;

async function run(command, arguments_, cwd, extraEnvironment = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnvironment } });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} ${arguments_.join(" ")} failed (${signal ?? `exit ${code}`})`)));
  });
}

async function output(command, arguments_, cwd) {
  let stdout = "";
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: ["ignore", "pipe", "inherit"], env: process.env });
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} ${arguments_.join(" ")} failed (${signal ?? `exit ${code}`})`)));
  });
  return stdout;
}

try {
  await run("pnpm", ["dlx", `create-trestlejs@${before}`, project, "--no-git", "--no-install"], root);
  await run("pnpm", ["install"], project);
  let databaseUrl;
  let beforeRows;
  if (process.env.TRESTLE_ADJACENT_DATABASE_URL) {
    const postgres = createRequire(path.join(project, "package.json"))("postgres");
    const address = new URL(process.env.TRESTLE_ADJACENT_DATABASE_URL);
    if (!/^postgres(?:ql)?:$/u.test(address.protocol)) throw new Error("TRESTLE_ADJACENT_DATABASE_URL must be a PostgreSQL URL");
    address.pathname = "/postgres";
    maintenance = postgres(address.toString(), { max: 1 });
    const newDatabaseName = `trestle_upgrade_${randomBytes(8).toString("hex")}`;
    await maintenance.unsafe(`CREATE DATABASE "${newDatabaseName}"`);
    upgradeDatabaseName = newDatabaseName;
    address.pathname = `/${upgradeDatabaseName}`;
    databaseUrl = address.toString();
    await run("pnpm", ["db:migrate"], project, { DATABASE_URL: databaseUrl });
    await run("pnpm", ["db:seed", "tenant-isolation"], project, { DATABASE_URL: databaseUrl });
    const database = postgres(databaseUrl, { max: 1 });
    try {
      beforeRows = await database.unsafe('SELECT id, organization_id, name FROM tenant_record ORDER BY id');
      if (beforeRows.length !== 2 || beforeRows[0].organization_id === beforeRows[1].organization_id) {
        throw new Error("Published pre-upgrade seed did not create two isolated tenant records");
      }
    } finally { await database.end(); }
  }
  const markerPath = path.join(project, ".trestle/framework.json");
  const baselinePath = path.join(project, ".trestle/template-baseline.json");
  if (JSON.parse(await readFile(markerPath, "utf8")).templateVersion !== before
    || JSON.parse(await readFile(baselinePath, "utf8")).templateVersion !== before) {
    throw new Error("Published generator did not record the expected source version and baseline");
  }
  const customPath = path.join(project, "UPGRADE_CANARY.md");
  const customContent = "Application-owned content survives the adjacent upgrade.\n";
  await writeFile(customPath, customContent, { flag: "wx" });
  await run("pnpm", ["add", "--workspace-root", "--save-dev", "--save-exact", `trestlejs@${after}`], project);
  await run("pnpm", ["install", "--frozen-lockfile"], project);
  const beforeDiff = JSON.parse(await output("pnpm", ["exec", "trestle", "upgrade", "diff", "--json"], project)).data;
  if (!beforeDiff.baselineTrusted || beforeDiff.sourceTemplateVersion !== before || beforeDiff.targetTemplateVersion !== after) {
    throw new Error("Published adjacent-version source inventory is not trusted");
  }
  const migrationAudit = JSON.parse(await output("pnpm", ["exec", "trestle", "upgrade", "migrations", "--check", "--json"], project)).data;
  if (migrationAudit.classification !== "matching") throw new Error("Published adjacent migration histories differ");
  await run("pnpm", ["exec", "trestle", "upgrade", "source-apply", "--yes"], project);
  if (databaseUrl) {
    await run("pnpm", ["db:migrate"], project, { DATABASE_URL: databaseUrl });
    const postgres = createRequire(path.join(project, "package.json"))("postgres");
    const database = postgres(databaseUrl, { max: 1 });
    try {
      const afterRows = await database.unsafe('SELECT id, organization_id, name FROM tenant_record ORDER BY id');
      if (JSON.stringify(afterRows) !== JSON.stringify(beforeRows)) throw new Error("Adjacent migration changed tenant-owned application records");
      const [rls] = await database.unsafe("SELECT relforcerowsecurity FROM pg_class WHERE relname = 'tenant_record'");
      if (!rls?.relforcerowsecurity) throw new Error("Adjacent migration did not preserve forced tenant RLS");
    } finally { await database.end(); }
    await run("pnpm", ["--filter", "./packages/db", "exec", "vitest", "run", "src/rls.integration.test.ts"], project,
      { TRESTLE_RLS_TEST_DATABASE_URL: databaseUrl });
  }
  await run("pnpm", ["exec", "trestle", "upgrade", "source-finalize", "--yes"], project);
  await run("pnpm", ["exec", "trestle", "upgrade", "check"], project);
  await run("pnpm", ["exec", "trestle", "ci", "validate"], project);
  if (await readFile(customPath, "utf8") !== customContent) throw new Error("Upgrade modified application-owned content");
  if (JSON.parse(await readFile(markerPath, "utf8")).templateVersion !== after
    || JSON.parse(await readFile(baselinePath, "utf8")).templateVersion !== after) {
    throw new Error("Published upgrade did not advance the reviewed source version and baseline");
  }
  console.log(`Published adjacent upgrade ${before} → ${after} passed with local checks, application content preserved${databaseUrl ? ", two-tenant PostgreSQL records and forced RLS verified" : ""}.`);
} finally {
  if (maintenance) {
    if (upgradeDatabaseName) {
      const [{ count }] = await maintenance.unsafe("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname = $1", [upgradeDatabaseName]);
      if (count === 0) await maintenance.unsafe(`DROP DATABASE "${upgradeDatabaseName}"`);
      else console.error(`Preserved disposable PostgreSQL database ${upgradeDatabaseName}: ${count} active connection(s)`);
    }
    await maintenance.end();
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
