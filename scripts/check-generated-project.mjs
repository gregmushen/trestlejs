import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "trestle-release-canary-"));
const project = path.join(temporaryRoot, "release-canary");

async function run(command, arguments_, cwd, extraEnvironment = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnvironment } });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} ${arguments_.join(" ")} failed (${signal ?? `exit ${code}`})`)));
  });
}

try {
  const coreArchive = path.join(temporaryRoot, "trestlejs-core.tgz");
  const cliArchive = path.join(temporaryRoot, "trestlejs.tgz");
  await run("pnpm", ["build"], root);
  await run("pnpm", ["--dir", "packages/core", "pack", "--out", coreArchive], root);
  await run("pnpm", ["--dir", "packages/cli", "pack", "--out", cliArchive], root);
  await run(process.execPath, [path.join(root, "packages/create/dist/bin.js"), project, "--no-git", "--no-install"], root);
  const manifestPath = path.join(project, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.devDependencies.trestlejs = `file:${cliArchive}`;
  manifest.pnpm = { ...(manifest.pnpm ?? {}), overrides: { ...(manifest.pnpm?.overrides ?? {}), "@trestlejs/core": `file:${coreArchive}` } };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await run("pnpm", ["install"], project);
  const upgradePlan = JSON.parse(execFileSync(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "upgrade", "plan", "--json"], { cwd: project, encoding: "utf8" }));
  for (const operation of upgradePlan.data.operations) {
    if (operation.classification === "manual-review") throw new Error(`Generated project requires manual upgrade review: ${operation.id}`);
  }
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "generate", "resource", "Author"], project);
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "generate", "resource", "Article", "--field", "summary:text?", "published:boolean?", "authorId:relation?:Author:set-null"], project);
  const workerEntry = await readFile(path.join(project, "apps", "worker", "src", "index.ts"), "utf8");
  for (const resource of ["author", "article"]) {
    if (!workerEntry.includes(`app.route("/", ${resource}Routes);`) || !workerEntry.includes(`eventConsumers.register(${resource}CreatedEvent, handle${resource[0].toUpperCase()}${resource.slice(1)}Created);`)) {
      throw new Error(`Generated ${resource} Worker route or event handler was not registered`);
    }
  }
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "ci", "validate"], project);
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "architecture", "check"], project);
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "resource", "add-field", "Article", "archived:boolean?", "--yes"], project);
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "architecture", "check"], project);
  await run("pnpm", ["check"], project);
  if (process.env.TRESTLE_GENERATED_DATABASE_URL) {
    await run("pnpm", ["db:migrate"], project, { DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL });
    await run("pnpm", ["--filter", "./packages/db", "exec", "vitest", "run"], project, { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL, TRESTLE_INBOX_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL, TRESTLE_INBOX_TEST_ADMIN_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL });
    await run("pnpm", ["--filter", "./packages/billing", "exec", "vitest", "run"], project, { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL });
    await run("pnpm", ["--filter", "./apps/worker", "exec", "vitest", "run", "src/system.integration.test.ts"], project, { TRESTLE_SYSTEM_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL, TRESTLE_SYSTEM_TEST_ARTICLES: "1" });
  }
  const generatedProjectManifest = path.join(project, ".trestle", "project.yaml");
  const manifestSource = await readFile(generatedProjectManifest, "utf8");
  if (!manifestSource.includes("  queues: false")) throw new Error("generated project did not declare opt-in Queues");
  if (!manifestSource.includes("  r2: false")) throw new Error("generated project did not declare opt-in R2");
  await writeFile(generatedProjectManifest, manifestSource.replace("  queues: false", "  queues: true").replace("  r2: false", "  r2: true").replace("  workflows: false", "  workflows: true"));
  await run(process.execPath, ["scripts/queue-config.mjs", "render", "preview", "release-canary-worker-pr-1"], project);
  const queueDoctor = spawnSync(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "doctor", "--env", "preview", "--json"], {
    cwd: project, encoding: "utf8", env: { ...process.env, TRESTLE_WRANGLER_CONFIG: "apps/worker/.trestle-queues.wrangler.jsonc" },
  });
  const queueDoctorReport = JSON.parse(queueDoctor.stdout);
  if (queueDoctorReport.data.checks.find((item) => item.id === "cloudflare.queues.binding")?.status !== "pass") {
    throw new Error("Doctor did not recognize the opt-in preview Queue binding");
  }
  if (queueDoctorReport.data.checks.find((item) => item.id === "cloudflare.r2.binding")?.status !== "pass") {
    throw new Error("Doctor did not recognize the opt-in preview R2 binding");
  }
  if (queueDoctorReport.data.checks.find((item) => item.id === "cloudflare.workflows.binding")?.status !== "pass") {
    throw new Error("Doctor did not recognize the opt-in preview Workflow binding");
  }
  await run("pnpm", ["--filter", "./apps/worker", "exec", "wrangler", "deploy", "--dry-run", "--config", ".trestle-queues.wrangler.jsonc", "--env", "preview"], project);
  console.log(`Generated release canary passed at ${project}`);
} finally {
  if (process.env.TRESTLE_KEEP_GENERATED === "1") {
    console.log(`Retained generated project at ${project}`);
  } else {
    await rm(temporaryRoot, { recursive: true });
  }
}
