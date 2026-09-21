import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-cli-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".trestle"));
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
});
