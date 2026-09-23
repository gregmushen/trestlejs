import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadProjectManifest, TRESTLEJS_VERSION } from "@trestlejs/core";
import { readSecrets } from "trestlejs";
import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function filesBelow(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("createProject", () => {
  it("renders a valid project without executing optional setup", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "create-trestlejs-"));
    temporaryDirectories.push(parent);
    const commands: string[] = [];
    const result = await createProject({
      cwd: parent,
      directory: "hello",
      install: false,
      git: false,
      run: async (command) => {
        commands.push(command);
      },
    });

    expect(result.name).toBe("hello");
    expect(commands).toEqual([]);
    expect(await readFile(path.join(result.directory, ".trestle", "project.yaml"), "utf8")).toContain(
      "name: hello",
    );
    expect(await readFile(path.join(result.directory, ".trestle", "project.yaml"), "utf8")).toContain(
      "queues: false",
    );
    expect(JSON.parse(await readFile(path.join(result.directory, ".trestle", "recovery.json"), "utf8")).artifactBucket).toBe("hello-worker-artifacts");
    expect(await readFile(path.join(result.directory, "package.json"), "utf8")).toContain(
      '"name": "hello"',
    );
    const packageDocument = JSON.parse(
      await readFile(path.join(result.directory, "package.json"), "utf8"),
    ) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(packageDocument.scripts.dev).toBe("trestle dev");
    expect(packageDocument.devDependencies.trestlejs).toBe(TRESTLEJS_VERSION);
    expect(await readFile(path.join(result.directory, "compose.yaml"), "utf8")).toContain(
      "postgres:17-alpine",
    );
    expect((await stat(path.join(result.directory, "config", "master.key"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(result.directory, "config", "credentials.yml.enc"), "utf8")).toContain('"algorithm":"aes-256-gcm"');
    const secrets = await readSecrets(result.directory, "local");
    expect(secrets).toMatchObject({
      BETTER_AUTH_URL: "http://localhost:42069",
      DATABASE_DRIVER: "postgres-js",
      DATABASE_URL: "postgres://trestle:trestle@localhost:55432/hello",
    });
    expect(secrets.BETTER_AUTH_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(
      await readFile(path.join(result.directory, "packages", "db", "src", "auth-schema.ts"), "utf8"),
    ).toContain("export const organization = pgTable(");
    expect(
      await readFile(path.join(result.directory, "apps", "worker", "src", "index.ts"), "utf8"),
    ).toContain('app.on(["GET", "POST"], "/api/auth/*"');
    expect(
      await readFile(path.join(result.directory, "apps", "app", "src", "main.tsx"), "utf8"),
    ).toContain('path: "/sign-up"');
    expect(
      await readFile(path.join(result.directory, "apps", "site", "src", "config", "site.ts"), "utf8"),
    ).toContain('name: "Southwind"');
    expect(
      await readFile(path.join(result.directory, "apps", "site", "src", "config", "site.ts"), "utf8"),
    ).toContain('"http://localhost:42069"');
    const deployWorkflow = await readFile(path.join(result.directory, ".github", "workflows", "deploy.yml"), "utf8");
    expect(deployWorkflow).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(deployWorkflow).toContain("pnpm exec trestle secrets check --env staging");
    expect(deployWorkflow).toContain("db:roles:bootstrap");
    expect(deployWorkflow.indexOf("Migrate staging")).toBeLessThan(deployWorkflow.indexOf("Configure staging database roles"));
    expect(deployWorkflow.indexOf("Migrate production")).toBeLessThan(deployWorkflow.indexOf("Configure production database roles"));
    expect(deployWorkflow).not.toContain("trestlejs@latest");
    const previewWorkflow = await readFile(path.join(result.directory, ".github", "workflows", "preview.yml"), "utf8");
    expect(previewWorkflow).toContain("--worker-name");
    expect(previewWorkflow).toContain("cloudflare-worker.mjs delete");
    expect(previewWorkflow).toContain("cloudflare-pages.mjs delete");
    expect(previewWorkflow).toContain("neon-preview.mjs ensure");
    expect(previewWorkflow).toContain("neon-preview.mjs delete");
    expect(previewWorkflow).toContain("bootstrap-managed");
    expect(previewWorkflow.indexOf("Migrate preview database")).toBeLessThan(previewWorkflow.indexOf("Configure preview database roles"));
    const applicationCatalog = await readFile(path.join(result.directory, "packages", "events", "src", "application-catalog.ts"), "utf8");
    expect(applicationCatalog).toContain("defineEventCatalog([])");
    expect(await readFile(path.join(result.directory, "packages", "events", "src", "catalog.ts"), "utf8")).toContain("export function defineEvent");
    const setupSkill = await readFile(
      path.join(result.directory, ".agents", "skills", "trestle-setup", "SKILL.md"),
      "utf8",
    );
    expect(setupSkill).toContain("name: trestle-setup");
    expect(setupSkill).toContain("## Non-negotiable boundary");
    expect(
      await readFile(
        path.join(
          result.directory,
          ".agents",
          "skills",
          "trestle-setup",
          "references",
          "architecture.md",
        ),
        "utf8",
      ),
    ).toContain("# Trestle Architecture Conventions");

    const manifest = await loadProjectManifest(result.directory);
    for (const relativePath of [...Object.values(manifest.apps), ...Object.values(manifest.packages)]) {
      expect((await stat(path.join(result.directory, relativePath))).isDirectory()).toBe(true);
    }
    for (const filePath of await filesBelow(result.directory)) {
      const content = await readFile(filePath, "utf8");
      expect(content).not.toContain("__TRESTLE_PROJECT_NAME__");
      expect(content).not.toContain("__TRESTLEJS_VERSION__");
      if (path.basename(filePath) === "package.json") {
        expect(() => JSON.parse(content)).not.toThrow();
      }
    }
  }, 15_000);

  it("refuses a non-empty target", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "create-trestlejs-"));
    temporaryDirectories.push(parent);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.join(parent, "hello"));
    await writeFile(path.join(parent, "hello", "keep.txt"), "mine");

    await expect(
      createProject({ cwd: parent, directory: "hello", install: false, git: false }),
    ).rejects.toThrow("not empty");
    expect(await readFile(path.join(parent, "hello", "keep.txt"), "utf8")).toBe("mine");
  });
});
