import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const current = JSON.parse(await readFile(path.join(root, "packages/cli/package.json"), "utf8")).version;
const match = /^0\.1\.0-alpha\.(\d+)$/u.exec(current);
const betaCandidate = current === "0.1.0-beta.1" || current === "0.1.0-beta.2";
if ((!match || Number(match[1]) < 3) && !betaCandidate) {
  throw new Error("Adjacent upgrade rehearsal requires two published predecessors or a supported beta candidate");
}

// During a release candidate's CI, the candidate is not yet on npm. Rehearse
// the two latest published versions through their real create and upgrade CLIs.
const before = current === "0.1.0-beta.2" ? "0.1.0-alpha.135" : betaCandidate ? "0.1.0-alpha.134" : `0.1.0-alpha.${Number(match[1]) - 2}`;
const after = current === "0.1.0-beta.2" ? "0.1.0-beta.1" : betaCandidate ? "0.1.0-alpha.135" : `0.1.0-alpha.${Number(match[1]) - 1}`;
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

function replaceExactlyOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Reviewed adjacent workflow transition did not match the published source exactly");
  return source.replace(before, after);
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
  const originalPackageSource = await readFile(path.join(project, "package.json"), "utf8");
  await run("pnpm", ["add", "--workspace-root", "--save-dev", "--save-exact", `trestlejs@${after}`], project);
  await run("pnpm", ["install", "--frozen-lockfile"], project);
  const beforeDiff = JSON.parse(await output("pnpm", ["exec", "trestle", "upgrade", "diff", "--json"], project)).data;
  if (!beforeDiff.baselineTrusted || beforeDiff.sourceTemplateVersion !== before || beforeDiff.targetTemplateVersion !== after) {
    throw new Error("Published adjacent-version source inventory is not trusted");
  }
  const migrationAudit = JSON.parse(await output("pnpm", ["exec", "trestle", "upgrade", "migrations", "--check", "--json"], project)).data;
  if (migrationAudit.classification !== "matching") throw new Error("Published adjacent migration histories differ");
  if (before === "0.1.0-alpha.134" && after === "0.1.0-alpha.135") {
    // Protected deployment source requires an exact published transition review.
    // Do not treat a changed application workflow as framework-owned.
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    const relative = ".github/workflows/deploy.yml";
    const workflowPath = path.join(project, relative);
    const source = await readFile(workflowPath, "utf8");
    if (createHash("sha256").update(source).digest("hex") !== baseline.files?.[relative]) {
      throw new Error("Published Alpha 134 deployment workflow differs from its recorded baseline");
    }
    let reviewed = replaceExactlyOnce(source,
      "      - name: Configure and verify the staging platform admin database role\n",
      [
        "      - name: Rotate the staging browser fixture without sending email",
        "        run: |",
        '          export DATABASE_URL="$(pnpm exec trestle secrets get DATABASE_URL --env staging --raw)"',
        "          pnpm --filter ./packages/auth exec tsx src/staging-fixture.ts",
        "        env:",
        '          TRESTLE_MASTER_KEY: "${{ secrets.TRESTLE_MASTER_KEY }}"',
        "          TRESTLE_DEPLOY_ENV: staging",
        "      - name: Configure and verify the staging platform admin database role",
        "",
      ].join("\n"));
    reviewed = replaceExactlyOnce(reviewed,
      "      - name: Verify deployed staging site in Chromium without sending email\n        run: pnpm test:staging\n        env:\n",
      [
        "      - name: Verify deployed staging site and product in Chromium without sending email",
        "        run: |",
        '          export DATABASE_URL="$(pnpm exec trestle secrets get DATABASE_URL --env staging --raw)"',
        "          pnpm test:staging",
        "        env:",
        '          TRESTLE_MASTER_KEY: "${{ secrets.TRESTLE_MASTER_KEY }}"',
        "",
      ].join("\n"));
    const template = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", relative), "utf8");
    const target = template.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary");
    if (reviewed !== target) throw new Error("Published Alpha 135 deployment workflow differs from the narrowly reviewed staging fixture transition");
    await writeFile(workflowPath, target);

    const packageRelative = "package.json";
    const packagePath = path.join(project, packageRelative);
    const packageSource = JSON.parse(await readFile(packagePath, "utf8"));
    const expected = JSON.parse(originalPackageSource);
    if (createHash("sha256").update(originalPackageSource).digest("hex") !== baseline.files?.[packageRelative]
      || expected.devDependencies?.trestlejs !== before) throw new Error("Published Alpha 134 package manifest differs from its recorded baseline");
    expected.devDependencies.trestlejs = after;
    if (!isDeepStrictEqual(packageSource, expected)) {
      throw new Error("Published Alpha 134 package manifest has edits beyond the CLI version bump");
    }
    expected.scripts["test:staging"] = replaceExactlyOnce(expected.scripts["test:staging"],
      "TRESTLE_BROWSER_MODE=deployed TRESTLE_ALLOW_LIVE_EMAIL_TESTS=0 playwright test tests/browser/site-handoff.spec.ts tests/browser/deployed-product.spec.ts",
      "TRESTLE_BROWSER_MODE=deployed TRESTLE_DEPLOY_ENV=staging TRESTLE_ALLOW_LIVE_EMAIL_TESTS=0 playwright test tests/browser/site-handoff.spec.ts tests/browser/staging-product.spec.ts");
    expected.scripts.test = replaceExactlyOnce(expected.scripts.test,
      "scripts/serve-site.test.mjs scripts/smoke-operational.test.mjs",
      "scripts/serve-site.test.mjs scripts/smoke-http.test.mjs scripts/smoke-operational.test.mjs");
    const packageTemplate = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", packageRelative), "utf8");
    const packageTarget = packageTemplate.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary").replaceAll("__TRESTLEJS_VERSION__", after);
    if (!isDeepStrictEqual(expected, JSON.parse(packageTarget))) throw new Error("Published Alpha 135 package manifest differs from the reviewed staging commands");
    await writeFile(packagePath, packageTarget);
    console.log("Reviewed the known Alpha 134 → 135 staging fixture workflow and command transition; application edits remain subject to source-apply review.");
  }
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
