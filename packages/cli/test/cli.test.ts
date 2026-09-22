import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
  it("emits a versioned project description", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["project", "--json"], output.runtime)).toBe(0);
    const document = JSON.parse(output.stdout()) as { schemaVersion: number; data: { manifest: unknown } };
    expect(document.schemaVersion).toBe(1);
    expect(document.data.manifest).toBeDefined();
    expect(output.stderr()).toBe("");
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
    expect(await readFile(path.join(root, "apps/app/src/main.tsx"), "utf8")).toContain('path: "/articles"');

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
  });
});
