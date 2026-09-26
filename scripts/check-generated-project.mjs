import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "trestle-release-canary-"));
const project = path.join(temporaryRoot, "release-canary");
// The release canary once hit EADDRINUSE while binding the generated site's
// fixed 42068 default, even after localhost readiness probes refused it.
// Give this isolated browser exercise distinct per-run ports without changing
// the generated application's defaults. Keep them below Linux's default
// ephemeral-client range so an outbound connection cannot race Vite's bind.
const browserSitePort = process.env.TRESTLE_BROWSER_SITE_PORT ?? String(randomInt(20_000, 23_000));
const browserAppPort = process.env.TRESTLE_BROWSER_APP_PORT ?? String(randomInt(23_000, 26_000));
const browserWorkerPort = process.env.TRESTLE_BROWSER_WORKER_PORT ?? String(randomInt(26_000, 29_000));
for (const [name, port] of [["SITE", browserSitePort], ["APP", browserAppPort], ["WORKER", browserWorkerPort]]) {
  if (!/^[0-9]+$/u.test(port) || Number(port) < 1024 || Number(port) > 65535) {
    throw new Error(`TRESTLE_BROWSER_${name}_PORT must be an unprivileged TCP port`);
  }
}
if (new Set([browserSitePort, browserAppPort, browserWorkerPort]).size !== 3) throw new Error("Browser test ports must be distinct");
const browserSiteEnvironment = {
  TRESTLE_BROWSER_SITE_PORT: browserSitePort, TRESTLE_BROWSER_APP_PORT: browserAppPort,
  TRESTLE_BROWSER_WORKER_PORT: browserWorkerPort,
  SITE_URL: `http://localhost:${browserSitePort}`, APP_URL: `http://localhost:${browserAppPort}`,
  API_URL: `http://localhost:${browserWorkerPort}`,
};

/**
 * Runs vitest files and requires each named scenario to have passed, so a
 * database-gated suite cannot silently skip. Used only when a database is set.
 */
async function requireScenarios(projectRoot, filter, files, environment, titles) {
  const report = path.join(temporaryRoot, `scenarios-${path.basename(projectRoot)}-${filter.replaceAll(/[^a-z]/gu, "")}.json`);
  await run("pnpm", ["--filter", filter, "exec", "vitest", "run", ...files, "--reporter=default", "--reporter=json", `--outputFile.json=${report}`], projectRoot, environment);
  const results = JSON.parse(await readFile(report, "utf8")).testResults.flatMap((file) => file.assertionResults);
  const missing = titles.filter((title) => !results.some((result) => result.title === title && result.status === "passed"));
  if (missing.length) throw new Error(`Required ${filter} scenarios did not pass: ${missing.join("; ")}`);
  console.log(`Verified ${titles.length} ${filter} scenarios in ${path.basename(projectRoot)}`);
}

async function run(command, arguments_, cwd, extraEnvironment = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnvironment } });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} ${arguments_.join(" ")} failed (${signal ?? `exit ${code}`})`)));
  });
}

try {
  const cliArchive = path.join(temporaryRoot, "trestlejs.tgz");
  await run("pnpm", ["build"], root);
  await run("pnpm", ["--dir", "packages/cli", "pack", "--out", cliArchive], root);
  await run(process.execPath, [path.join(root, "packages/create/dist/bin.js"), project, "--no-git", "--no-install"], root);
  const manifestPath = path.join(project, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.devDependencies.trestlejs = `file:${cliArchive}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await run("pnpm", ["install"], project);
  const lockfilePath = path.join(project, "pnpm-lock.yaml");
  const lockfile = await readFile(lockfilePath, "utf8");
  await run("pnpm", ["install", "--frozen-lockfile"], project);
  if (await readFile(lockfilePath, "utf8") !== lockfile) {
    throw new Error("Frozen generated-project install changed its lockfile");
  }
  const sourceDiff = JSON.parse(execFileSync("pnpm", ["exec", "trestle", "upgrade", "diff", "--json"], { cwd: project, encoding: "utf8" }));
  if (!sourceDiff.data.baselineTrusted || sourceDiff.data.entries.some((entry) => entry.classification !== "same" && entry.path !== "package.json")) {
    throw new Error("Fresh generated project did not match its bundled target template");
  }
  const previewWorkflow = await readFile(path.join(project, ".github/workflows/preview.yml"), "utf8");
  if (!previewWorkflow.includes('BETTER_AUTH_URL: "${{ steps.preview.outputs.api_url }}"')) {
    throw new Error("Preview verification links must target the Worker API origin");
  }
  const migrationAudit = JSON.parse(execFileSync("pnpm", ["exec", "trestle", "upgrade", "migrations", "--check", "--json"], { cwd: project, encoding: "utf8" }));
  if (migrationAudit.data.classification !== "matching" || migrationAudit.data.commonPrefix < 1) {
    throw new Error("Fresh generated project did not match its bundled migration history");
  }
  const migrationsPath = path.join(project, "packages", "db", "migrations");
  const journalPath = path.join(migrationsPath, "meta", "_journal.json");
  const assertMonotonicJournal = async () => {
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    let previous = -1;
    for (const entry of journal.entries) {
      if (!Number.isSafeInteger(entry.when) || entry.when <= previous) throw new Error(`Migration journal is not strictly monotonic at ${entry.tag}`);
      previous = entry.when;
    }
  };
  const migrationNames = async () => (await readdir(migrationsPath)).filter((name) => name.endsWith(".sql")).sort();
  // Every migration file needs its journal entry and snapshot, or drizzle-kit silently skips it.
  const assertJournalMatchesFiles = async () => {
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const tags = journal.entries.map((entry) => `${entry.tag}.sql`);
    const files = await migrationNames();
    if (JSON.stringify(tags) !== JSON.stringify(files)) throw new Error(`Migration journal does not match migration files: ${files.filter((file) => !tags.includes(file)).concat(tags.filter((tag) => !files.includes(tag))).join(", ")}`);
    const snapshots = new Set((await readdir(path.join(migrationsPath, "meta"))).filter((name) => name.endsWith("_snapshot.json")));
    // 0004 was published as hand-written SQL without a snapshot; published history is never rewritten.
    const handWritten = new Set(["0004_async_outbox"]);
    for (const entry of journal.entries) {
      if (!handWritten.has(entry.tag) && !snapshots.has(`${String(entry.idx).padStart(4, "0")}_snapshot.json`)) throw new Error(`Migration ${entry.tag} has no Drizzle snapshot`);
    }
  };
  await assertJournalMatchesFiles();
  const migrationsBeforeGenerate = await migrationNames();
  await run("pnpm", ["--filter", "./packages/db", "db:generate"], project, { DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/trestle_test" });
  const migrationsAfterGenerate = await migrationNames();
  if (JSON.stringify(migrationsAfterGenerate) !== JSON.stringify(migrationsBeforeGenerate)) {
    throw new Error("Checked-in database snapshots are not idempotent; db:generate created an unexpected migration");
  }
  await assertMonotonicJournal();
  const upgradePlan = JSON.parse(execFileSync(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "upgrade", "plan", "--json"], { cwd: project, encoding: "utf8" }));
  if (upgradePlan.data.operations.find((operation) => operation.id === "cli-version")?.classification !== "manual-review") {
    throw new Error("Tarball-installed canary did not exercise the package/lockfile upgrade gate");
  }
  for (const operation of upgradePlan.data.operations) {
    // This canary deliberately installs the CLI from a local tarball rather
    // than the registry, so only the production package/lockfile pin differs.
    if (operation.classification === "manual-review" && operation.id !== "cli-version") throw new Error(`Generated project requires manual upgrade review: ${operation.id}`);
  }
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "generate", "resource", "Author"], project);
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "generate", "resource", "Article", "--field", "summary:text?", "published:boolean?", "authorId:relation?:Author:set-null", "--webhook-event", "created", "updated"], project);
  // Shared reference data, and a tenant resource that references it.
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "generate", "resource", "Crop", "--shared", "--field", "family:string?"], project);
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "generate", "resource", "Planting", "--field", "cropId:relation?:Crop:restrict"], project);
  await assertMonotonicJournal();
  const workerEntry = await readFile(path.join(project, "apps", "worker", "src", "index.ts"), "utf8");
  const eventCatalog = await readFile(path.join(project, "packages", "events", "src", "application-catalog.ts"), "utf8");
  if (!eventCatalog.includes('type: "resource.article.created", version: 1')
    || !eventCatalog.includes('type: "resource.article.updated", version: 1')
    || eventCatalog.includes('type: "resource.article.deleted", version: 1')
    || eventCatalog.includes('type: "resource.author.created", version: 1')) {
    throw new Error("Generated public webhook projections do not match explicit resource opt-ins");
  }
  for (const resource of ["author", "article"]) {
    if (!workerEntry.includes(`app.route("/", ${resource}Routes);`) || ["Created", "Updated", "Deleted"].some((kind) =>
      !workerEntry.includes(`eventConsumers.register(${resource}${kind}Event, handle${resource[0].toUpperCase()}${resource.slice(1)}${kind}, { authority: "tenant" });`))) {
      throw new Error(`Generated ${resource} Worker route or event handler was not registered`);
    }
  }
  const articleScreen = await readFile(path.join(project, "apps", "app", "src", "resources", "article.tsx"), "utf8");
  if (!articleScreen.includes('session?.user.id, organizationId') || !articleScreen.includes('enabled: Boolean(session?.user.id && organizationId)')) {
    throw new Error("Generated resource query is not scoped to both the current user and organization");
  }
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "ci", "validate"], project);
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "architecture", "check"], project);
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "resource", "add-field", "Article", "archived:boolean?", "--yes"], project);
  await assertMonotonicJournal();
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "architecture", "check"], project);
  await run("pnpm", ["check"], project, browserSiteEnvironment);
  if (process.env.TRESTLE_GENERATED_DATABASE_URL) {
    await run("pnpm", ["db:migrate"], project, { DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL });
    await requireScenarios(project, "./packages/auth", ["src/preview-fixture.integration.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "rejects staging and production before touching their databases",
      "signs in as a verified user without sending any email",
    ]);
    await requireScenarios(project, "./packages/auth", ["src/staging-fixture.integration.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "rejects preview, production, and local before touching a database",
      "rotates a verified account without email or extra users",
    ]);
    await run("pnpm", ["--filter", "./packages/db", "exec", "vitest", "run"], project, { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL, TRESTLE_INBOX_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL, TRESTLE_INBOX_TEST_ADMIN_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL });
    await requireScenarios(project, "./packages/db", ["src/crop-rls.integration.test.ts", "src/crop-editor.integration.test.ts", "src/planting-rls.integration.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "is readable by every tenant and writable by none",
      "lets only the platform role write",
      "audits each change and rejects stale revisions",
      "lets every tenant reference shared Crop rows through cropId",
    ]);
    await requireScenarios(project, "./packages/db", ["src/support-view.integration.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "exchanges once, keeps actor separate from Alice, audits reads, and fails closed on exit",
      "revoking the operator role or Alice's membership immediately ends the view",
      "refuses an expired handoff even while the support session remains active",
      "does not grant the app role direct access to support credentials",
    ]);
    await requireScenarios(project, "./packages/db", ["src/scheduled-jobs.integration.test.ts"], { TRESTLE_INBOX_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL, TRESTLE_INBOX_TEST_ADMIN_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "lets exactly one of many overlapping runs hold a job's lease",
      "fences completion by lease token and never re-runs a completed due slot",
      "reclaims an expired lease and rejects the stale holder's completion",
    ]);
    await requireScenarios(project, "./packages/db", ["src/webhook-replay.integration.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "creates one linked execution, signs a local attempt, and never alters the original",
      "rejects non-failed, expired, and inactive deliveries without an audit row",
    ]);
    await requireScenarios(project, "./packages/db", ["src/webhook-replay-owner.integration.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "gives the owner login no tenant webhook rows and no audit forgery",
      "keeps platform replay working through the dedicated replay role",
      "runs the replay function as a NOLOGIN role with only the columns replay reads and writes",
    ]);
    await requireScenarios(project, "./packages/db", ["src/webhook-claims.integration.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "bounds simultaneous leases per endpoint across competing workers",
      "bounds one tenant across competing endpoints without throttling another tenant",
    ]);
    await requireScenarios(project, "./packages/db", ["src/billing-events.integration.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "commits the receipt, subscription, and entitlements together and ignores a duplicate",
      "rolls back an invalid entitlement projection, records failure, then safely retries",
      "rolls back the projection and receipt finalization when a domain event is invalid",
      "publishes normalized plan, past-due, and cancellation transitions with request correlation",
      "serializes concurrent duplicate deliveries so the projection runs once",
      "never transfers one provider subscription to a second organization",
      "does not grant the application role permission to rewrite ownership",
      "rejects a competing subscription while the current one is active",
      "allows a canceled subscription to be replaced but supersedes later old events",
      "serializes two organizations racing to claim the same provider identity",
      "retries an early invoice and publishes exactly once after ownership is established",
      "rejects cross-tenant and changed subscription identities without publishing",
      "rolls back invalid invoice payloads and leaves their receipt retryable",
    ]);
    await requireScenarios(project, "./packages/data", [], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "rolls back update and delete when the event cannot be recorded",
      "rejects stale revisions without writing",
    ]);
    await run("pnpm", ["--filter", "./packages/billing", "exec", "vitest", "run"], project, { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL });
    // P1 adoption: a project with pre-#186 ID-only relations moves to composite keys without losing data.
    await run(process.execPath, [path.join(root, "scripts/check-legacy-relations.mjs")], root, { TRESTLE_LEGACY_CLI_ARCHIVE: cliArchive });
    await requireScenarios(project, "./packages/billing", ["src/reconciliation.integration.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "commits a receipt and a tenantless reconciliation request without contacting the provider",
      "records a redelivered receipt once and acknowledges it as a duplicate after reconciliation",
      "assigns distinct generations to concurrent receipts for one subscription",
      "converges on current provider state when events arrive older first",
      "converges on current provider state when events arrive newer first",
      "orders by durable generation, not timestamps, when two receipts share a timestamp",
      "runs another pass when a receipt arrives while a reconciliation holds the lease",
      "fences a slow reconciliation after its lease expires and a newer one commits",
      "keeps the last confirmed projection through provider failure and converges on retry",
      "recovers work abandoned by a crashed reconciler once its lease expires",
      "commits the subscription and entitlements together or not at all",
      "applies cancellation, allows replacement, and ignores a delayed event from the replaced subscription",
      "handles a deleted provider subscription as canceled and a missing one without touching the projection",
      "never lets an unknown mapping or another tenant's metadata touch a projection",
      "preserves platform entitlement overrides across reconciliation",
      "reconciles the local payment adapter through the same durable path",
      "orders local adapter changes by durable generation even if a stale local lookup is slow",
    ]);
    const workerSystemEnvironment = { TRESTLE_SYSTEM_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL, TRESTLE_SYSTEM_TEST_ARTICLES: "1", TRESTLE_SYSTEM_TEST_WEBHOOKS: "1" };
    // The scale-to-zero canary drains pending outbox rows, so it runs on its own after the parallel suites.
    await run("pnpm", ["--filter", "./apps/worker", "exec", "vitest", "run", "--exclude", "src/system.integration.test.ts", "--exclude", "src/scheduler.integration.test.ts"], project, workerSystemEnvironment);
    await requireScenarios(project, "./apps/worker", ["src/scheduler.integration.test.ts"], workerSystemEnvironment, [
      "dispatches a created event on commit, without waiting for a cron",
      "fires a scheduled webhook retry at its due time",
      "runs a registered application job when due, once, then sleeps",
      "makes zero database queries over a sampled idle window",
    ]);
    await requireScenarios(project, "./apps/worker", ["src/system.integration.test.ts"], workerSystemEnvironment, [
      "verifies email, signs in, selects an organization, and reads tenant billing",
    ]);
    await requireScenarios(project, "./apps/worker", ["src/resend-webhook.integration.test.ts"], { TRESTLE_SYSTEM_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "persists a verified event once and acknowledges a signed duplicate",
      "rejects a tampered raw body and an expired signature before persistence",
      "returns a retryable response during a database outage and records redelivery",
    ]);
    await requireScenarios(project, "./apps/worker", ["src/billing-webhook.integration.test.ts"], { TRESTLE_SYSTEM_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "activates entitlements from a signed subscription once and acknowledges duplicates",
      "rejects a signed subscription lacking tenant or plan metadata without an event receipt",
      "retries Checkout until subscription ownership exists and never grants access from Checkout alone",
      "publishes invoice payment outcomes only for a locally owned subscription",
      "reconciles a signed but stale active event against the current cancelled Stripe subscription",
      "keeps a provider lookup failure retryable without exposing the provider response",
      "recovers subscription identity from current Stripe state when the signed snapshot lacks metadata",
      "commits the receipt and a durable reconciliation request before any Stripe call when a Queue is bound",
      "rejects a forged reconciliation message before it reaches Stripe",
      "does not acknowledge the webhook unless the receipt and request commit together",
      "rejects a Stripe subscription that no longer exists without changing the projection",
    ]);
    // Tenant-side admin-capability scenarios: cross-plane denial and a scoped API key before and after revocation.
    await requireScenarios(project, "./apps/worker", ["src/machine-access.integration.test.ts", "src/execution-context.test.ts", "src/access-routes.integration.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "never lets organization ownership reach artifacts without an application role",
      "keeps service-account management in the application plane",
      "mints a scoped key that works before revocation and fails after, with audited changes",
    ]);
    await requireScenarios(project, "./apps/worker", ["src/support-view.integration.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "exchanges once without an Alice login, blocks ordinary routes, and ends immediately with the platform session",
    ]);
    await run("pnpm", ["test:browser"], project, { ...browserSiteEnvironment, TRESTLE_BROWSER_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL, TRESTLE_BROWSER_ARTICLES: "1" });
    await run("pnpm", ["exec", "playwright", "test", "tests/browser/site-handoff.spec.ts", "--list"], project, {
      TRESTLE_BROWSER_MODE: "deployed",
      SITE_URL: "https://site.example.test",
      APP_URL: "https://app.example.test",
      API_URL: "https://api.example.test",
    });
    await run("pnpm", ["exec", "playwright", "test", "tests/browser/deployed-product.spec.ts", "--list"], project, {
      TRESTLE_BROWSER_MODE: "deployed",
      SITE_URL: "https://site.example.test",
      APP_URL: "https://app.example.test",
      API_URL: "https://api.example.test",
    });
    await run("pnpm", ["exec", "playwright", "test", "tests/browser/preview-product.spec.ts", "--list"], project, {
      TRESTLE_BROWSER_MODE: "deployed",
      SITE_URL: "https://site.example.test",
      APP_URL: "https://app.example.test",
      API_URL: "https://api.example.test",
    });
    await run("pnpm", ["exec", "playwright", "test", "tests/browser/staging-product.spec.ts", "--list"], project, {
      TRESTLE_BROWSER_MODE: "deployed",
      TRESTLE_DEPLOY_ENV: "staging",
      SITE_URL: "https://site.example.test",
      APP_URL: "https://app.example.test",
      API_URL: "https://api.example.test",
    });
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
  await run(process.execPath, ["scripts/queue-config.mjs", "render", "preview", "release-canary-worker-pr-1", "--without-cron"], project);
  const cronFreePreview = JSON.parse(await readFile(path.join(project, "apps/worker/.trestle-queues.wrangler.jsonc"), "utf8"));
  if (cronFreePreview.env.preview.triggers || !cronFreePreview.env.preview.durable_objects || !cronFreePreview.env.preview.queues || !cronFreePreview.env.preview.r2_buckets || !cronFreePreview.env.preview.workflows) {
    throw new Error("Explicit cron-free preview lost required bindings or kept a cron trigger");
  }
  await run("pnpm", ["--filter", "./apps/worker", "exec", "wrangler", "deploy", "--dry-run", "--config", ".trestle-queues.wrangler.jsonc", "--env", "preview"], project);
  // Admin disabled (the default): no admin app and no admin deployment configuration.
  if (await stat(path.join(project, "apps", "admin")).then(() => true, () => false)) throw new Error("The default project generated apps/admin");
  // Admin enabled: a second project generated with --admin installs, builds, and passes its admin
  // suite; with a database that includes real platform sign-in and cross-plane denial.
  const adminProject = path.join(temporaryRoot, "admin-canary");
  await run(process.execPath, [path.join(root, "packages/create/dist/bin.js"), adminProject, "--no-git", "--no-install", "--admin"], root);
  const adminManifestPath = path.join(adminProject, "package.json");
  const adminManifest = JSON.parse(await readFile(adminManifestPath, "utf8"));
  adminManifest.devDependencies.trestlejs = `file:${cliArchive}`;
  await writeFile(adminManifestPath, `${JSON.stringify(adminManifest, null, 2)}\n`);
  await run("pnpm", ["install"], adminProject);
  const adminDiff = JSON.parse(execFileSync(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "upgrade", "diff", "--json"], { cwd: adminProject, encoding: "utf8" }));
  if (!adminDiff.data.baselineTrusted || adminDiff.data.entries.some((entry) => entry.classification !== "same" && entry.path !== "package.json")) {
    throw new Error("Fresh admin-enabled project did not match its bundled target template");
  }
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "architecture", "check"], adminProject);
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "ci", "validate"], adminProject);
  // A shared resource's platform editor: permission, admin Worker routes, view registry entry, and view.
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "generate", "resource", "Crop", "--shared"], adminProject);
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "architecture", "check"], adminProject);
  await run("pnpm", ["typecheck"], adminProject);
  await run("pnpm", ["--filter", "./apps/admin", "build"], adminProject);
  await run("pnpm", ["--filter", "./apps/admin", "exec", "wrangler", "deploy", "--dry-run", "--env", "production"], adminProject);
  await run("pnpm", ["--filter", "./apps/admin", "exec", "vitest", "run"], adminProject, process.env.TRESTLE_GENERATED_DATABASE_URL ? { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL } : {});
  if (process.env.TRESTLE_GENERATED_DATABASE_URL) {
    await requireScenarios(adminProject, "./apps/admin", ["worker/support-handoff.integration.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "requires the operator's own member-bound session and creates a one-time app link",
    ]);
    // Platform sign-in, cross-plane denial, and support-session entry and exit against PostgreSQL.
    await requireScenarios(adminProject, "./apps/admin", ["worker/index.integration.test.ts", "worker/index.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "signs a real account in on the admin origin and requires a platform role",
      "denies a tenant Owner with no platform role",
      "requires platform sign-in and a platform role; tenant authority grants nothing",
      "enters and exits a support session over HTTP; tenant reads require the open session",
      "redrives a dead outbox event over HTTP and audits it with the request's correlation ID",
      // Step-up: fresh assurance for platform actions, factor changes gated at the strongest enrolled factor, operators only, and fail-closed environments.
      "requires fresh assurance for platform actions and reports it in the session",
      ...["POST /api/auth/two-factor/enable", "POST /api/auth/two-factor/disable", "POST /api/auth/two-factor/generate-backup-codes", "GET /api/auth/passkey/generate-register-options", "POST /api/auth/passkey/verify-registration", "POST /api/auth/passkey/delete-passkey"]
        .map((route) => `requires fresh evidence at the strongest enrolled factor for ${route}`),
      "serves factor endpoints only to platform operators, and leaves sign-in challenges open",
      "refuses the seeded local admin's factor changes outside local development",
      "treats an unset APP_ENV as deployed for the local account and the platform connection",
      "checks assurance on every admin request and fails closed",
      // Minimum sign-in level: an operator with a factor must have signed in with it, on every admin request.
      "requires a second-factor sign-in for every admin request once the operator has a factor",
      "refuses a password session for a passkey-only operator",
      "applies the minimum sign-in level to operator-only factor routes, but not to sign-in challenges or a first enrollment",
      "reports the operator's enrolled factors in the session through the shared auth database handle",
      "lets a factorless operator in with a password session so they can enroll a factor",
      "skips freshness for stepUp: false routes but keeps the minimum sign-in level",
      "reports step-up as due when the session is below the environment's action level",
      "gives Better Auth the admin's fail-closed environment, so security events are never labelled local by default",
    ]);
    // Session assurance is recorded by the endpoint that proves it, never upgraded by enrollment, and stored behind the platform role.
    await requireScenarios(adminProject, "./packages/auth", ["src/index.integration.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "records password assurance for a password sign-in without a second factor",
      "leaves a rotated session without assurance when its prior session had none",
      "keeps an enrollment session at its prior assurance, then records MFA only for a second-factor sign-in",
      "upgrades a signed-in operator who steps up with an enrolled second factor",
    ]);
    await requireScenarios(adminProject, "./packages/db", ["src/assurance.integration.test.ts"], { TRESTLE_RLS_TEST_DATABASE_URL: process.env.TRESTLE_GENERATED_DATABASE_URL }, [
      "records, upgrades, and cascades how a session was authenticated",
      "keeps the tenant role from writing account-security events",
    ]);
  }
  const adminStatus = (projectRoot) => execFileSync(process.execPath, ["scripts/admin-capability.mjs", "status"], { cwd: projectRoot, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" } }).trim();
  if (adminStatus(project) !== "enabled=false" || adminStatus(adminProject) !== "enabled=true") throw new Error("Deploy workflow admin detection does not match capabilities.admin");

  // Admin enabled later: `trestle apply` on a fresh default project scaffolds exactly the template's admin app.
  const applyProject = path.join(temporaryRoot, "apply-canary");
  await run(process.execPath, [path.join(root, "packages/create/dist/bin.js"), applyProject, "--no-git", "--no-install"], root);
  const applyManifestPath = path.join(applyProject, "package.json");
  const applyManifest = JSON.parse(await readFile(applyManifestPath, "utf8"));
  applyManifest.devDependencies.trestlejs = `file:${cliArchive}`;
  await writeFile(applyManifestPath, `${JSON.stringify(applyManifest, null, 2)}\n`);
  await run("pnpm", ["install"], applyProject);
  const cli = path.join(root, "packages/cli/dist/bin.js");
  await run(process.execPath, [cli, "plan", "init"], applyProject);
  const setupPath = path.join(applyProject, ".trestle", "setup.json");
  const setupPlan = JSON.parse(await readFile(setupPath, "utf8"));
  if (setupPlan.apps.admin !== false
    || !setupPlan.secrets.some((secret) => secret.name === "DATABASE_ADMIN_URL" && secret.target === "admin")
    || !setupPlan.secrets.some((secret) => secret.required.length === 0)) {
    throw new Error("plan init omitted the admin declaration or optional secret requirements");
  }
  await run(process.execPath, [cli, "plan", "validate", ".trestle/setup.json"], applyProject);
  setupPlan.apps.admin = true;
  setupPlan.capabilities.admin = true;
  await writeFile(setupPath, `${JSON.stringify(setupPlan, null, 2)}\n`);
  const adminPlanDiff = JSON.parse(execFileSync(process.execPath, [cli, "plan", "diff", ".trestle/setup.json", "--json"], { cwd: applyProject, encoding: "utf8" })).data.items;
  for (const id of ["apps.admin", "capabilities.admin"]) {
    if (!adminPlanDiff.some((item) => item.id === id && item.classification === "create")) throw new Error(`SetupPlan did not propose ${id}`);
  }
  await run(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "apply", ".trestle/setup.json", "--yes"], applyProject);
  await run("pnpm", ["install", "--frozen-lockfile"], applyProject);
  const converged = JSON.parse(execFileSync(process.execPath, [cli, "plan", "diff", ".trestle/setup.json", "--json"], { cwd: applyProject, encoding: "utf8" })).data;
  if (!converged.converged) throw new Error("Enabled admin SetupPlan did not converge after apply");
  const appliedDiff = JSON.parse(execFileSync(process.execPath, [path.join(root, "packages/cli/dist/bin.js"), "upgrade", "diff", "--json"], { cwd: applyProject, encoding: "utf8" }));
  const appliedAdminFiles = appliedDiff.data.entries.filter((entry) => entry.path.startsWith("apps/admin/"));
  if (!appliedDiff.data.baselineTrusted || appliedAdminFiles.length === 0 || appliedDiff.data.entries.some((entry) => entry.classification !== "same" && entry.path !== "package.json")) {
    throw new Error("trestle apply did not scaffold the platform admin exactly as the bundled template");
  }
  if (adminStatus(applyProject) !== "enabled=true") throw new Error("trestle apply did not enable capabilities.admin");
  await run(process.execPath, [cli, "generate", "admin-module", "crop-editorial", "--permission", "platform.operations.read"], applyProject);
  await run("pnpm", ["--filter", "./apps/admin", "check:views"], applyProject);
  await run("pnpm", ["--filter", "./apps/admin", "build"], applyProject);
  console.log(`Generated release canary passed at ${project}`);
} finally {
  if (process.env.TRESTLE_KEEP_GENERATED === "1") {
    console.log(`Retained generated project at ${project}`);
  } else {
    await rm(temporaryRoot, { recursive: true });
  }
}
