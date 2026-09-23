import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TRESTLEJS_VERSION } from "@trestlejs/core";
import { afterEach, describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-cli-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".trestle"));
  await mkdir(path.join(root, ".agents", "skills", "trestle-setup"), { recursive: true });
  await writeFile(path.join(root, ".agents", "skills", "trestle-setup", "SKILL.md"), "---\nname: trestle-setup\ndescription: fixture\n---\n");
  await mkdir(path.join(root, "apps", "app"), { recursive: true });
  await mkdir(path.join(root, "apps", "worker"), { recursive: true });
  await mkdir(path.join(root, "packages", "contracts"), { recursive: true });
  await writeFile(
    path.join(root, ".trestle", "project.yaml"),
    `schemaVersion: 1
project:
  name: fixture
apps:
  app: apps/app
  worker: apps/worker
packages:
  contracts: packages/contracts
tenancy:
  model: organization
  enforcement: postgres-rls
database:
  engine: postgresql
  defaultProvider: neon
capabilities:
  r2: true
  queues: true
  workflows: true
  durableObjects: true
  admin: false
environments: [local, preview, staging, production]
`,
  );
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function capture(root: string, input = "") {
  let stdout = "";
  let stderr = "";
  return {
    runtime: {
      cwd: () => root,
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
      stdin: async () => input,
      isTTY: () => false,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("TrestleJS CLI", () => {
  it("does not generate application routes against a pre-registry authority model", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "packages", "context", "src"), { recursive: true });
    await writeFile(path.join(root, "packages", "context", "src", "index.ts"), 'export const authority = { plane: "organization", permissions: new Set() };\n');
    const output = capture(root);
    expect(await executeCli(["generate", "resource", "Article"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("authority model 3");
  });

  it("emits a versioned project description", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["project", "--json"], output.runtime)).toBe(0);
    const document = JSON.parse(output.stdout()) as { schemaVersion: number; data: { manifest: unknown } };
    expect(document.schemaVersion).toBe(1);
    expect(document.data.manifest).toBeDefined();
    expect(output.stderr()).toBe("");
  });

  it("reports environment capability intent without claiming provider verification", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["env", "status", "--env", "staging", "--json"], output.runtime)).toBe(0);
    const document = JSON.parse(output.stdout()) as { data: { environment: string; capabilities: Array<{ name: string; state: string }>; requiredVariables: string[] } };
    expect(document.data.environment).toBe("staging");
    expect(document.data.capabilities).toContainEqual({ name: "queues", state: "declared" });
    expect(document.data.requiredVariables).toEqual(["API_URL", "APP_URL", "DATABASE_RUNTIME_ROLE", "SITE_URL"]);
  });

  it("rejects unsafe isolated Worker names before reading or pushing credentials", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["secrets", "push", "--env", "preview", "--worker-name", "fixture;destroy"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("lowercase DNS-safe name");
  });

  it("does not allow a Worker-name override to retarget staging or production secrets", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["secrets", "push", "--env", "production", "--worker-name", "fixture-worker-pr-42"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("only allowed for isolated previews");
  });

  it("requires explicit confirmation before bootstrapping a remote runtime role", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["db", "roles", "bootstrap", "--env", "staging", "--role", "trestle_runtime"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("mutates the remote database; rerun with --yes");
  });

  it("requires explicit confirmation before production log access", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["logs", "--env", "production"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("production log access requires --yes");
  });

  it("requires an authenticated local session before seeding billing", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["payments", "stripe", "seed", "--organization", "org-1"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("requires --cookie-stdin");
  });

  it("requires an explicit console authority plane", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["console"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("requires --tenant or --platform-admin");
    const mixed = capture(root);
    expect(await executeCli(["console", "--tenant", "acme", "--platform-admin"], mixed.runtime)).toBe(1);
    expect(mixed.stderr()).toContain("different authority planes");
  });

  it("validates outbox retention cutoffs and limits before reading secrets", async () => {
    const root = await fixture();
    const local = capture(root);
    expect(await executeCli(["queue", "prune", "--env", "local", "--before", "2026-01-01T00:00:00Z"], local.runtime)).toBe(1);
    expect(local.stderr()).toContain("local outbox retention");
    const cutoff = capture(root);
    expect(await executeCli(["queue", "prune", "--env", "staging", "--before", "2026-01-01"], cutoff.runtime)).toBe(1);
    expect(cutoff.stderr()).toContain("--before must be an ISO UTC timestamp");
    const limit = capture(root);
    expect(await executeCli(["queue", "prune", "--env", "staging", "--before", "2026-01-01T00:00:00Z", "--limit", "10001"], limit.runtime)).toBe(1);
    expect(limit.stderr()).toContain("--limit must be between 1 and 10000");
  });

  it("requires confirmation before creating recovery resources or retrying remote workflows", async () => {
    const root = await fixture();
    const backup = capture(root);
    expect(await executeCli(["backup", "verify", "--env", "production", "--to", "restore-test"], backup.runtime)).toBe(1);
    expect(backup.stderr()).toContain("temporary Neon branch");
    const restore = capture(root);
    expect(await executeCli(["restore", "create", "--env", "production", "--to", "restore-test"], restore.runtime)).toBe(1);
    expect(restore.stderr()).toContain("requires --yes");
    const workflow = capture(root);
    expect(await executeCli(["workflow", "retry", "publish", "instance-1", "--env", "production"], workflow.runtime)).toBe(1);
    expect(workflow.stderr()).toContain("requires --yes");
  });

  it("plans upgrades without mutation and requires confirmation to apply", async () => {
    const root = await fixture();
    const packagePath = path.join(root, "package.json");
    await writeFile(packagePath, '{"devDependencies":{"trestlejs":"0.1.0-alpha.8"}}\n');
    const plan = capture(root);
    expect(await executeCli(["upgrade", "plan"], plan.runtime)).toBe(0);
    expect(plan.stdout()).toContain("cli-version");
    expect(await readFile(packagePath, "utf8")).toContain("alpha.8");
    const apply = capture(root);
    expect(await executeCli(["upgrade", "apply"], apply.runtime)).toBe(1);
    expect(apply.stderr()).toContain("requires --yes");
  });

  it("rejects runtime-role bootstrap for local and preview environments", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["db", "roles", "bootstrap", "--env", "preview", "--role", "trestle_runtime", "--yes"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("requires staging or production");
  });

  it("runs a read-only passing doctor", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["doctor", "--json"], output.runtime)).toBe(0);
    const document = JSON.parse(output.stdout()) as {
      data: { summary: { failed: number; passed: number } };
    };
    expect(document.data.summary.failed).toBe(0);
    expect(document.data.summary.passed).toBeGreaterThan(0);
  });

  it("fails doctor when a declared path is absent", async () => {
    const root = await fixture();
    const output = capture(root);
    const { rm } = await import("node:fs/promises");
    await rm(path.join(root, "apps", "worker"), { recursive: true });
    expect(await executeCli(["doctor"], output.runtime)).toBe(1);
    expect(output.stdout()).toContain("worker is missing");
  });

  it("initializes, writes, validates, and reveals encrypted credentials deliberately", async () => {
    const root = await fixture();
    const manifestPath = path.join(root, ".trestle", "project.yaml");
    const manifest = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, `${manifest}secrets:\n  TEST_SECRET:\n    target: worker\n    required: [local]\n`);
    const initialized = capture(root);
    expect(await executeCli(["secrets", "init"], initialized.runtime)).toBe(0);

    const set = capture(root, "swordfish\n");
    expect(await executeCli(["secrets", "set", "TEST_SECRET"], set.runtime)).toBe(0);

    const check = capture(root);
    expect(await executeCli(["secrets", "check"], check.runtime)).toBe(0);
    expect(check.stdout()).toContain("credentials are valid");

    const show = capture(root);
    expect(await executeCli(["secrets", "get", "TEST_SECRET", "--raw"], show.runtime)).toBe(0);
    expect(show.stdout()).toBe("swordfish");

    const encrypted = await import("node:fs/promises").then(({ readFile }) =>
      readFile(path.join(root, "config", "credentials.yml.enc"), "utf8"),
    );
    expect(encrypted).not.toContain("swordfish");
  });

  it("generates an application-owned React Email template, fixture, and test", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["generate", "email", "WelcomeUser"], output.runtime)).toBe(0);
    const generated = await readFile(path.join(root, "packages", "integrations", "src", "email", "templates", "welcome-user.tsx"), "utf8");
    expect(generated).toContain("WelcomeUserEmailProps");
    expect(output.stdout()).toContain("welcome-user.test.tsx");
  });

  it("validates, diffs, applies, resumes, and inspects a resource SetupPlan", async () => {
    const root = await fixture();
    for (const directory of [
      "packages/contracts/src",
      "packages/domain/src",
      "packages/data/src",
      "packages/db/src",
      "packages/db/migrations",
      "apps/worker/src",
      "apps/app/src",
    ]) await mkdir(path.join(root, directory), { recursive: true });
    for (const file of [
      "packages/contracts/src/index.ts",
      "packages/domain/src/index.ts",
      "packages/data/src/index.ts",
      "packages/db/src/index.ts",
    ]) await writeFile(path.join(root, file), "export {};\n");
    await writeFile(path.join(root, "apps/worker/src/index.ts"), 'import { Hono } from "hono";\nconst app = new Hono();\napp.get("/api/health", (context) => context.json({ status: "ok" }));\nexport default app;\n');
    await writeFile(path.join(root, "apps/app/src/main.tsx"), 'const rootRoute = createRootRoute({ component: Shell });\nconst routeTree = rootRoute.addChildren([]);\n');
    const plan = {
      schemaVersion: 1,
      minimumTrestleVersion: TRESTLEJS_VERSION,
      project: { name: "fixture" },
      apps: { site: false, app: true, worker: true },
      tenancy: { model: "organization", enforcement: "postgres-rls" },
      database: { engine: "postgresql", provider: "neon" },
      capabilities: { r2: true, queues: true, workflows: true, durableObjects: true, admin: false },
      integrations: { email: false, billing: false },
      environments: ["local", "preview", "staging", "production"],
      secrets: [],
      resources: [{ name: "Article", tenant: true, crud: true }],
      externalResources: [],
      destructiveOperations: [],
      verification: { commands: ["pnpm check"] },
    };
    const planPath = path.join(root, ".trestle", "setup.json");
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);

    const validate = capture(root);
    expect(await executeCli(["plan", "validate", ".trestle/setup.json"], validate.runtime)).toBe(0);
    expect(validate.stdout()).toContain("contains no plaintext secret values");
    await writeFile(path.join(root, ".trestle", "future.json"), `${JSON.stringify({ ...plan, minimumTrestleVersion: "0.1.0-alpha.999" }, null, 2)}\n`);
    const future = capture(root);
    expect(await executeCli(["plan", "validate", ".trestle/future.json"], future.runtime)).toBe(1);
    expect(future.stderr()).toContain("or newer");

    const before = capture(root);
    expect(await executeCli(["plan", "diff", ".trestle/setup.json", "--json"], before.runtime)).toBe(0);
    expect(JSON.parse(before.stdout()).data.items).toContainEqual(expect.objectContaining({ id: "resources.Article", classification: "create" }));

    expect(await executeCli(["apply", ".trestle/setup.json"], capture(root).runtime)).toBe(1);
    const apply = capture(root);
    expect(await executeCli(["apply", ".trestle/setup.json", "--yes"], apply.runtime)).toBe(0);
    expect(apply.stdout()).toContain("resources.Article");
    expect(await readFile(path.join(root, "packages/db/src/article-schema.ts"), "utf8")).toContain(".enableRLS()");
    const appSource = await readFile(path.join(root, "apps/app/src/main.tsx"), "utf8");
    expect(appSource).toContain('path: "/articles"');
    const routeSource = await readFile(path.join(root, "apps/worker/src/resources/article-routes.ts"), "utf8");
    expect(routeSource).toContain("requireExecutionContext");
    expect(routeSource).toContain('access.require({ permission: "resource.read" })');
    expect(routeSource).toContain('access.require({ permission: "resource.write" })');
    expect(routeSource).not.toContain("organization.");
    expect(routeSource).toContain("new ArticleService(new PostgresArticleRepository");
    const eventSource = await readFile(path.join(root, "apps/worker/src/resources/article-events.ts"), "utf8");
    expect(eventSource).toContain('name: "resource.article.created"');
    expect(eventSource).toContain("Invalid Article created event payload");
    const workerSource = await readFile(path.join(root, "apps/worker/src/index.ts"), "utf8");
    expect(workerSource).toContain("eventConsumers.register(articleCreatedEvent, handleArticleCreated);");
    const repositorySource = await readFile(path.join(root, "packages/data/src/resources/article-repository.ts"), "utf8");
    expect(repositorySource).toContain("eq(article.organizationId, this.organizationId)");
    const screenSource = await readFile(path.join(root, "apps/app/src/resources/article.tsx"), "utf8");
    expect(screenSource).toContain('const key = ["articles", organizationId] as const');
    expect(screenSource).toContain("createArticleApi");
    const clientSource = await readFile(path.join(root, "apps/app/src/api/article.ts"), "utf8");
    expect(clientSource).toContain('method: "PATCH"');
    expect(clientSource).toContain('method: "DELETE"');
    expect(clientSource).toContain("nextCursor");

    const resources = capture(root);
    expect(await executeCli(["resources", "--json"], resources.runtime)).toBe(0);
    expect(JSON.parse(resources.stdout()).data.resources[0].name).toBe("Article");
    const routes = capture(root);
    expect(await executeCli(["routes", "--json"], routes.runtime)).toBe(0);
    expect(JSON.parse(routes.stdout()).data.routes).toContainEqual(expect.objectContaining({ method: "POST", path: "/api/articles", resource: "Article" }));

    const after = capture(root);
    expect(await executeCli(["plan", "diff", ".trestle/setup.json", "--json"], after.runtime)).toBe(0);
    expect(JSON.parse(after.stdout()).data.converged).toBe(true);
    const resume = capture(root);
    expect(await executeCli(["apply", ".trestle/setup.json", "--yes"], resume.runtime)).toBe(0);

    const domainPath = path.join(root, "packages/domain/src/resources/article.ts");
    await writeFile(domainPath, `${await readFile(domainPath, "utf8")}\n// application-owned customization\n`);
    await rm(path.join(root, "packages/data/src/resources/article-repository.ts"));
    const drift = capture(root);
    expect(await executeCli(["plan", "diff", ".trestle/setup.json", "--json"], drift.runtime)).toBe(0);
    expect(JSON.parse(drift.stdout()).data.items).toContainEqual(expect.objectContaining({ id: "resources.Article.sources", classification: "create" }));
    expect(await executeCli(["apply", ".trestle/setup.json", "--yes"], capture(root).runtime)).toBe(0);
    expect(await readFile(path.join(root, "packages/data/src/resources/article-repository.ts"), "utf8")).toContain("PostgresArticleRepository");
    expect(await readFile(domainPath, "utf8")).toContain("application-owned customization");
    const repaired = capture(root);
    expect(await executeCli(["plan", "diff", ".trestle/setup.json", "--json"], repaired.runtime)).toBe(0);
    expect(JSON.parse(repaired.stdout()).data.converged).toBe(true);
  });
});
