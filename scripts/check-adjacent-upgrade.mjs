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
  // Alpha 107 added a generated package test script, but its source-apply CLI
  // cannot recognize the package-version-only edit made by pnpm. The Alpha 108
  // CLI fixes that case. Keep the historical published rehearsal honest: for
  // this one transition, prove the old manifest matches its recorded hash
  // and pnpm changed only the dependency version, then apply the reviewed target
  // template manifest before invoking the published upgrade command.
  if (before === "0.1.0-alpha.106" && after === "0.1.0-alpha.107") {
    const packagePath = path.join(project, "package.json");
    const source = JSON.parse(await readFile(packagePath, "utf8"));
    const expected = JSON.parse(originalPackageSource);
    if (expected.devDependencies?.trestlejs !== before) throw new Error("Published Alpha 106 project did not declare the expected CLI version");
    expected.devDependencies.trestlejs = after;
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    const originalHash = createHash("sha256").update(originalPackageSource).digest("hex");
    if (originalHash !== baseline.files?.["package.json"] || !isDeepStrictEqual(source, expected)) {
      throw new Error("Published Alpha 106 package manifest is not pristine apart from the Alpha 107 dependency bump");
    }
    const templatePackage = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", "package.json"), "utf8");
    const reviewedPackage = templatePackage.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary").replaceAll("__TRESTLEJS_VERSION__", after);
    await writeFile(packagePath, reviewedPackage);
    console.log("Reviewed the known Alpha 106 → 107 generated package-script transition; all other source remains subject to source-apply review.");
  }
  if (before === "0.1.0-alpha.109" && after === "0.1.0-alpha.110") {
    // Deployment workflows are intentionally protected from automatic source
    // application. Rehearse a narrow human review of the published transition:
    // the source must still match its Alpha 109 baseline, and only the three
    // exact Alpha 110 staging-gate edits may produce the target workflow.
    const relative = ".github/workflows/deploy.yml";
    const workflowPath = path.join(project, relative);
    const source = await readFile(workflowPath, "utf8");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (createHash("sha256").update(source).digest("hex") !== baseline.files?.[relative]) {
      throw new Error("Published Alpha 109 deployment workflow differs from its recorded baseline");
    }
    let reviewed = replaceExactlyOnce(source,
      "  staging:\n    environment: staging\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n",
      "  staging:\n    environment: staging\n    runs-on: ubuntu-latest\n    timeout-minutes: 25\n");
    reviewed = replaceExactlyOnce(reviewed,
      "      - name: Verify deployed staging signup, email, and organizations in Chromium\n",
      "      - name: Verify deployed staging signup, email, organizations, and async delivery in Chromium\n");
    reviewed = replaceExactlyOnce(reviewed,
      "          echo \"::add-mask::$RESEND_API_KEY\"\n          pnpm test:staging\n",
      "          echo \"::add-mask::$RESEND_API_KEY\"\n          export DATABASE_URL=\"$(pnpm exec trestle secrets get DATABASE_URL --env staging --raw)\"\n          echo \"::add-mask::$DATABASE_URL\"\n          pnpm test:staging\n");
    const template = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", relative), "utf8");
    const target = template.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary");
    if (reviewed !== target) throw new Error("Published Alpha 110 deployment workflow differs from the narrowly reviewed transition");
    await writeFile(workflowPath, target);
    console.log("Reviewed the known Alpha 109 → 110 protected deployment workflow transition; all other source remains subject to source-apply review.");
  }
  if (before === "0.1.0-alpha.112" && after === "0.1.0-alpha.113") {
    // Alpha 113 added a read-only Resend/Stripe preflight to protected
    // deployment workflows. Confirm the exact published Alpha 112 baseline
    // and narrowly review only those inserted steps before source-apply.
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    const preflight = (environment, mode) =>
      `      - name: Verify ${environment} Resend and Stripe credentials before provisioning\n`
      + `        run: |\n`
      + `          export RESEND_API_KEY="$(pnpm exec trestle secrets get RESEND_API_KEY --env ${environment} --raw)"\n`
      + `          echo "::add-mask::$RESEND_API_KEY"\n`
      + `          export STRIPE_SECRET_KEY="$(pnpm exec trestle secrets get STRIPE_SECRET_KEY --env ${environment} --raw)"\n`
      + `          echo "::add-mask::$STRIPE_SECRET_KEY"\n`
      + `          node scripts/transactional-provider-preflight.mjs\n`
      + `        env:\n`
      + `          TRESTLE_MASTER_KEY: "${'${{ secrets.TRESTLE_MASTER_KEY }}'}"\n`
      + `          TRESTLE_STRIPE_MODE: ${mode}\n`;
    for (const [relative, insertions] of [
      [".github/workflows/preview.yml", [["      - name: Provision isolated preview Queues\n", preflight("preview", "test")]]],
      [".github/workflows/deploy.yml", [["      - name: Provision staging Queues\n", preflight("staging", "test")], ["      - name: Provision production Queues\n", preflight("production", "live")]]],
    ]) {
      const workflowPath = path.join(project, relative);
      const source = await readFile(workflowPath, "utf8");
      if (createHash("sha256").update(source).digest("hex") !== baseline.files?.[relative]) {
        throw new Error(`Published Alpha 112 ${relative} differs from its recorded baseline`);
      }
      let reviewed = source;
      for (const [anchor, addition] of insertions) reviewed = replaceExactlyOnce(reviewed, anchor, `${addition}${anchor}`);
      const template = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", relative), "utf8");
      const target = template.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary");
      if (reviewed !== target) throw new Error(`Published Alpha 113 ${relative} differs from the narrowly reviewed transition`);
      await writeFile(workflowPath, target);
    }
    console.log("Reviewed the known Alpha 112 → 113 protected deployment workflow transitions; all other source remains subject to source-apply review.");
  }
  if (before === "0.1.0-alpha.113" && after === "0.1.0-alpha.114") {
    // Alpha 114 adds a sender-domain check to the three protected provider
    // preflights. Review only those exact lines against the published Alpha
    // 113 baseline; application-owned deployment edits still stop the upgrade.
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    for (const [relative, environments] of [
      [".github/workflows/preview.yml", ["preview"]],
      [".github/workflows/deploy.yml", ["staging", "production"]],
    ]) {
      const workflowPath = path.join(project, relative);
      const source = await readFile(workflowPath, "utf8");
      if (createHash("sha256").update(source).digest("hex") !== baseline.files?.[relative]) {
        throw new Error(`Published Alpha 113 ${relative} differs from its recorded baseline`);
      }
      let reviewed = source;
      for (const environment of environments) {
        const beforeLine = "          node scripts/transactional-provider-preflight.mjs\n";
        const preflightIndex = reviewed.indexOf(`      - name: Verify ${environment} Resend and Stripe credentials before provisioning\n`);
        if (preflightIndex < 0) throw new Error(`Published Alpha 113 ${environment} preflight is missing`);
        const lineIndex = reviewed.indexOf(beforeLine, preflightIndex);
        if (lineIndex < 0) throw new Error(`Published Alpha 113 ${environment} preflight command is missing`);
        reviewed = `${reviewed.slice(0, lineIndex)}${beforeLine}          pnpm exec trestle email doctor --env ${environment}\n${reviewed.slice(lineIndex + beforeLine.length)}`;
      }
      const template = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", relative), "utf8");
      const target = template.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary");
      if (reviewed !== target) throw new Error(`Published Alpha 114 ${relative} differs from the narrowly reviewed transition`);
      await writeFile(workflowPath, target);
    }
    console.log("Reviewed the known Alpha 113 → 114 protected provider preflights; all other source remains subject to source-apply review.");
  }
  if (before === "0.1.0-alpha.114" && after === "0.1.0-alpha.115") {
    // Alpha 115 aligned preview secret uploads with the exact rendered Worker
    // config. Protected workflow edits remain review-only: require the pristine
    // Alpha 114 baseline and exactly these three target changes.
    const relative = ".github/workflows/preview.yml";
    const workflowPath = path.join(project, relative);
    const source = await readFile(workflowPath, "utf8");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (createHash("sha256").update(source).digest("hex") !== baseline.files?.[relative]) {
      throw new Error("Published Alpha 114 preview workflow differs from its recorded baseline");
    }
    let reviewed = replaceExactlyOnce(source,
      'run: pnpm exec trestle secrets push --env preview --worker-name "${{ steps.preview.outputs.worker_name }}"',
      'run: pnpm exec trestle secrets push --env preview --worker-name "${{ steps.preview.outputs.worker_name }}" --worker-config .trestle-queues.wrangler.jsonc');
    for (const name of ["DATABASE_URL", "BETTER_AUTH_URL"]) {
      reviewed = replaceExactlyOnce(reviewed,
        `secret put ${name} --env preview --name "${'${{ steps.preview.outputs.worker_name }}'}"`,
        `secret put ${name} --env preview --config .trestle-queues.wrangler.jsonc`);
    }
    const template = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", relative), "utf8");
    const target = template.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary");
    if (reviewed !== target) throw new Error("Published Alpha 115 preview workflow differs from the narrowly reviewed transition");
    await writeFile(workflowPath, target);
    console.log("Reviewed the known Alpha 114 → 115 protected preview secret-target transition; all other source remains subject to source-apply review.");
  }
  if (before === "0.1.0-alpha.115" && after === "0.1.0-alpha.116") {
    // Alpha 116 moves preview verification links to the API and adds a
    // credential-backed browser gate. Verify the pristine protected workflow
    // and apply only these exact published changes for the rehearsal.
    const relative = ".github/workflows/preview.yml";
    const workflowPath = path.join(project, relative);
    const source = await readFile(workflowPath, "utf8");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (createHash("sha256").update(source).digest("hex") !== baseline.files?.[relative]) {
      throw new Error("Published Alpha 115 preview workflow differs from its recorded baseline");
    }
    let reviewed = replaceExactlyOnce(source,
      "      - name: Bind Better Auth to the isolated preview application\n",
      "      - name: Bind Better Auth to the isolated preview API\n");
    reviewed = replaceExactlyOnce(reviewed,
      '          BETTER_AUTH_URL: "${{ steps.preview.outputs.app_url }}"\n',
      '          BETTER_AUTH_URL: "${{ steps.preview.outputs.api_url }}"\n');
    reviewed = replaceExactlyOnce(reviewed,
      "      - name: Verify deployed site and application in Chromium\n        run: pnpm test:deployed\n        env:\n",
      "      - name: Verify deployed site and application in Chromium\n        run: |\n          export RESEND_API_KEY=\"$(pnpm exec trestle secrets get RESEND_API_KEY --env preview --raw)\"\n          echo \"::add-mask::$RESEND_API_KEY\"\n          pnpm test:deployed\n        env:\n          TRESTLE_MASTER_KEY: \"${{ secrets.TRESTLE_MASTER_KEY }}\"\n");
    const template = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", relative), "utf8");
    const target = template.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary");
    if (reviewed !== target) throw new Error("Published Alpha 116 preview workflow differs from the narrowly reviewed transition");
    await writeFile(workflowPath, target);
    console.log("Reviewed the known Alpha 115 → 116 protected preview auth and browser-gate transition; all other source remains subject to source-apply review.");
  }
  if (before === "0.1.0-alpha.116" && after === "0.1.0-alpha.117") {
    // Same-origin Pages routing changed protected deployment workflows. Require
    // each published Alpha 116 baseline and only the exact Alpha 117 edits.
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    for (const relative of [".github/workflows/preview.yml", ".github/workflows/deploy.yml"]) {
      const workflowPath = path.join(project, relative);
      const source = await readFile(workflowPath, "utf8");
      if (createHash("sha256").update(source).digest("hex") !== baseline.files?.[relative]) {
        throw new Error(`Published Alpha 116 ${relative} differs from its recorded baseline`);
      }
      let reviewed = source;
      const bindings = relative.endsWith("preview.yml")
        ? [["preview", '"${{ steps.preview.outputs.app_project }}" "${{ steps.preview.outputs.worker_name }}"', '${{ steps.preview.outputs.api_url }}', '${{ steps.preview.outputs.app_url }}']]
        : [["staging", "upgrade-canary-staging upgrade-canary-worker-staging", '${{ vars.API_URL }}', '${{ vars.APP_URL }}'],
          ["production", "upgrade-canary upgrade-canary-worker", '${{ vars.API_URL }}', '${{ vars.APP_URL }}']];
      for (const [environment, names, oldOrigin, newOrigin] of bindings) {
        const step = `      - name: Bind ${environment} Pages app to ${environment === "preview" ? "isolated API Worker" : "API Worker"}\n`
          + `        run: node scripts/cloudflare-pages.mjs bind-service ${names}\n`
          + `        env:\n`
          + `          CLOUDFLARE_API_TOKEN: "${'${{ secrets.CLOUDFLARE_API_TOKEN }}'}"\n`
          + `          CLOUDFLARE_ACCOUNT_ID: "${'${{ secrets.CLOUDFLARE_ACCOUNT_ID }}'}"\n`;
        const oldLine = `      - run: VITE_API_ORIGIN="${oldOrigin}" pnpm --filter @upgrade-canary/app build\n`;
        const expectedCount = environment === "staging" ? 2 : 1;
        if (reviewed.split(oldLine).length - 1 !== expectedCount) {
          throw new Error(`Published Alpha 116 ${environment} app build step did not match the reviewed transition`);
        }
        reviewed = reviewed.replace(oldLine,
          `${step}      - run: VITE_API_ORIGIN="${newOrigin}" pnpm --filter @upgrade-canary/app build\n`);
      }
      const template = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", relative), "utf8");
      const target = template.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary");
      if (reviewed !== target) throw new Error(`Published Alpha 117 ${relative} differs from the narrowly reviewed same-origin transition`);
      await writeFile(workflowPath, target);
    }
    console.log("Reviewed the known Alpha 116 → 117 protected same-origin Pages routing transitions; all other source remains subject to source-apply review.");
  }
  if (before === "0.1.0-alpha.117" && after === "0.1.0-alpha.118") {
    // Alpha 118 confines the paid test-card browser gate to preview. Review
    // this exact protected workflow edit against the published baseline.
    const relative = ".github/workflows/preview.yml";
    const workflowPath = path.join(project, relative);
    const source = await readFile(workflowPath, "utf8");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (createHash("sha256").update(source).digest("hex") !== baseline.files?.[relative]) {
      throw new Error("Published Alpha 117 preview workflow differs from its recorded baseline");
    }
    const reviewed = replaceExactlyOnce(source, "          pnpm test:deployed\n", "          pnpm test:preview\n");
    const template = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", relative), "utf8");
    const target = template.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary");
    if (reviewed !== target) throw new Error("Published Alpha 118 preview workflow differs from the narrowly reviewed test-only transition");
    await writeFile(workflowPath, target);
    console.log("Reviewed the known Alpha 117 → 118 protected preview browser-gate transition; all other source remains subject to source-apply review.");
  }
  if (before === "0.1.0-alpha.119" && after === "0.1.0-alpha.120") {
    // Alpha 120 inserts a read-only cron capacity check before remote writes.
    // Protected deployment workflows are never source-applied implicitly:
    // require the pristine published baseline and these exact six additions.
    const relative = ".github/workflows/deploy.yml";
    const workflowPath = path.join(project, relative);
    const source = await readFile(workflowPath, "utf8");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (createHash("sha256").update(source).digest("hex") !== baseline.files?.[relative]) {
      throw new Error("Published Alpha 119 deployment workflow differs from its recorded baseline");
    }
    let reviewed = source;
    for (const environment of ["staging", "production"]) {
      reviewed = replaceExactlyOnce(reviewed,
        `          pnpm exec trestle doctor --env ${environment}\n          node scripts/cloudflare-preflight.mjs\n`,
        `          pnpm exec trestle doctor --env ${environment}\n          node scripts/cloudflare-preflight.mjs\n          node scripts/cloudflare-cron-preflight.mjs\n`);
      reviewed = replaceExactlyOnce(reviewed,
        `          TRESTLE_WRANGLER_CONFIG: apps/worker/.trestle-queues.wrangler.jsonc\n      - name: Verify ${environment} Resend and Stripe credentials before provisioning\n`,
        `          TRESTLE_WRANGLER_CONFIG: apps/worker/.trestle-queues.wrangler.jsonc\n          TRESTLE_CRON_DEPLOY_ENV: ${environment}\n          CLOUDFLARE_WORKERS_PLAN: "${'${{ vars.CLOUDFLARE_WORKERS_PLAN }}'}"\n      - name: Verify ${environment} Resend and Stripe credentials before provisioning\n`);
    }
    const template = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", relative), "utf8");
    const target = template.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary");
    if (reviewed !== target) throw new Error("Published Alpha 120 deployment workflow differs from the narrowly reviewed cron-capacity transition");
    await writeFile(workflowPath, target);
    console.log("Reviewed the known Alpha 119 → 120 protected cron-capacity transition; all other source remains subject to source-apply review.");
  }
  if (before === "0.1.0-alpha.125" && after === "0.1.0-alpha.126") {
    // Alpha 126 explicitly omits cron from ephemeral preview Workers. A
    // protected workflow cannot be source-applied automatically: require the
    // published Alpha 125 hash and exactly this one reviewed command edit.
    const relative = ".github/workflows/preview.yml";
    const workflowPath = path.join(project, relative);
    const source = await readFile(workflowPath, "utf8");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (createHash("sha256").update(source).digest("hex") !== baseline.files?.[relative]) {
      throw new Error("Published Alpha 125 preview workflow differs from its recorded baseline");
    }
    const reviewed = replaceExactlyOnce(source,
      'run: node scripts/queue-config.mjs render preview "${{ steps.preview.outputs.worker_name }}"',
      'run: node scripts/queue-config.mjs render preview "${{ steps.preview.outputs.worker_name }}" --without-cron');
    const template = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", relative), "utf8");
    const target = template.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary");
    if (reviewed !== target) throw new Error("Published Alpha 126 preview workflow differs from the narrowly reviewed cron-free transition");
    await writeFile(workflowPath, target);
    console.log("Reviewed the known Alpha 125 → 126 protected preview cron-free transition; all other source remains subject to source-apply review.");
  }
  if (before === "0.1.0-alpha.127" && after === "0.1.0-alpha.128") {
    // Preview Checkout must return to the isolated PR app, not to a static
    // template URL. Review exactly this protected workflow command change.
    const relative = ".github/workflows/preview.yml";
    const workflowPath = path.join(project, relative);
    const source = await readFile(workflowPath, "utf8");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (createHash("sha256").update(source).digest("hex") !== baseline.files?.[relative]) {
      throw new Error("Published Alpha 127 preview workflow differs from its recorded baseline");
    }
    const reviewed = replaceExactlyOnce(source,
      '--var WEB_ORIGIN:${{ steps.preview.outputs.app_url }}',
      '--var WEB_ORIGIN:${{ steps.preview.outputs.app_url }} --var BILLING_RETURN_URL:${{ steps.preview.outputs.app_url }}/settings/billing');
    const template = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", relative), "utf8");
    const target = template.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary");
    if (reviewed !== target) throw new Error("Published Alpha 128 preview workflow differs from the narrowly reviewed billing-return transition");
    await writeFile(workflowPath, target);
    console.log("Reviewed the known Alpha 127 → 128 protected preview billing-return transition; all other source remains subject to source-apply review.");
  }
  if (before === "0.1.0-alpha.129" && after === "0.1.0-alpha.130") {
    // Alpha 130 replaces the unsafe preview Worker deletion path with one
    // that first detaches Queue bindings. Protected workflows still require
    // a baseline-matched, exact reviewed change before source-apply.
    const relative = ".github/workflows/preview.yml";
    const workflowPath = path.join(project, relative);
    const source = await readFile(workflowPath, "utf8");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (createHash("sha256").update(source).digest("hex") !== baseline.files?.[relative]) {
      throw new Error("Published Alpha 129 preview workflow differs from its recorded baseline");
    }
    const reviewed = replaceExactlyOnce(source,
      'run: node scripts/cloudflare-worker.mjs delete "${{ steps.preview.outputs.worker_name }}"',
      'run: node scripts/cloudflare-worker.mjs delete-preview "${{ steps.preview.outputs.worker_name }}"');
    const template = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", relative), "utf8");
    const target = template.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary");
    if (reviewed !== target) throw new Error("Published Alpha 130 preview workflow differs from the narrowly reviewed transition");
    await writeFile(workflowPath, target);
    console.log("Reviewed the known Alpha 129 → 130 protected preview cleanup transition; all other source remains subject to source-apply review.");
  }
  if (before === "0.1.0-alpha.130" && after === "0.1.0-alpha.131") {
    // Alpha 131's auth diagnostics import the generated context package. The
    // published upgrade leaves package manifests for human review, so verify
    // this exact new workspace dependency against the pristine Alpha 130
    // baseline before updating the manifest and its lockfile.
    const relative = "packages/auth/package.json";
    const packagePath = path.join(project, relative);
    const source = await readFile(packagePath, "utf8");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (createHash("sha256").update(source).digest("hex") !== baseline.files?.[relative]) {
      throw new Error("Published Alpha 130 auth manifest differs from its recorded baseline");
    }
    const expected = JSON.parse(source);
    if (expected.dependencies?.["@upgrade-canary/context"] !== undefined) {
      throw new Error("Published Alpha 130 auth manifest unexpectedly declares context");
    }
    expected.dependencies["@upgrade-canary/context"] = "workspace:*";
    const template = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", relative), "utf8");
    const target = template.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary");
    if (!isDeepStrictEqual(expected, JSON.parse(target))) {
      throw new Error("Published Alpha 131 auth manifest differs from the reviewed context dependency change");
    }
    await writeFile(packagePath, target);
    await run("pnpm", ["install", "--no-frozen-lockfile"], project);
    console.log("Reviewed the known Alpha 130 → 131 auth context dependency; all other source remains subject to source-apply review.");
  }
  if (before === "0.1.0-alpha.131" && after === "0.1.0-alpha.132") {
    // Protected preview workflows never source-apply without review. Alpha 132
    // inserted only the isolated Stripe test webhook lifecycle around Worker
    // deployment and cleanup. Verify the pristine published baseline, then
    // require those exact two insertions to equal the published target.
    const relative = ".github/workflows/preview.yml";
    const workflowPath = path.join(project, relative);
    const source = await readFile(workflowPath, "utf8");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (createHash("sha256").update(source).digest("hex") !== baseline.files?.[relative]) {
      throw new Error("Published Alpha 131 preview workflow differs from its recorded baseline");
    }
    const provision = [
      "      - name: Provision isolated Stripe test webhook and bind its signing secret",
      "        run: |",
      '          STRIPE_SECRET_KEY="$(pnpm exec trestle secrets get STRIPE_SECRET_KEY --env preview --raw)"',
      "          export STRIPE_SECRET_KEY",
      '          echo "::add-mask::$STRIPE_SECRET_KEY"',
      '          node scripts/stripe-preview.mjs provision "${{ steps.preview.outputs.api_url }}"',
      "        env:",
      '          TRESTLE_MASTER_KEY: "${{ secrets.TRESTLE_MASTER_KEY }}"',
      '          CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}"',
      '          CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"',
      "",
    ].join("\n");
    const cleanup = [
      "      - name: Delete isolated Stripe test webhook",
      "        if: always()",
      "        run: |",
      '          STRIPE_SECRET_KEY="$(pnpm exec trestle secrets get STRIPE_SECRET_KEY --env preview --raw)"',
      "          export STRIPE_SECRET_KEY",
      '          echo "::add-mask::$STRIPE_SECRET_KEY"',
      '          node scripts/stripe-preview.mjs delete "${{ steps.preview.outputs.api_url }}"',
      "        env:",
      '          TRESTLE_MASTER_KEY: "${{ secrets.TRESTLE_MASTER_KEY }}"',
      "",
    ].join("\n");
    const authBinding = [
      '          BETTER_AUTH_URL: "${{ steps.preview.outputs.api_url }}"',
      '          CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}"',
      '          CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"',
      "",
    ].join("\n");
    let reviewed = replaceExactlyOnce(source, authBinding, `${authBinding}${provision}`);
    reviewed = replaceExactlyOnce(reviewed,
      "      - name: Delete isolated Worker\n",
      `${cleanup}      - name: Delete isolated Worker\n`);
    const template = await readFile(path.join(project, "node_modules", "trestlejs", "dist", "template", relative), "utf8");
    const target = template.replaceAll("__TRESTLE_PROJECT_NAME__", "upgrade-canary");
    if (reviewed !== target) throw new Error("Published Alpha 132 preview workflow differs from the narrowly reviewed Stripe webhook transition");
    await writeFile(workflowPath, target);
    console.log("Reviewed the known Alpha 131 → 132 isolated Stripe preview webhook transition; all other source remains subject to source-apply review.");
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
