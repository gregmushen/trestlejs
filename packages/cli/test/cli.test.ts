import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TRESTLEJS_VERSION } from "../src/core.js";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { executeCli, initializeSecrets } from "../src/index.js";

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
  it("refuses production Stripe webhook changes before project access unless explicitly confirmed", async () => {
    const root = await fixture();
    const output = capture(root, "sk_live_management");
    expect(await executeCli(["payments", "stripe", "webhook", "configure", "--env", "production",
      "--url", "https://example.test/webhooks/stripe", "--api-key-stdin", "--apply", "--operation-id", "operation123"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("production webhook mutation requires --apply --yes");
  });

  it("prints the folded status summary at the top of email doctor for local", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "apps", "worker", "wrangler.jsonc"), "{}");
    await initializeSecrets(root, "local");
    const output = capture(root);
    expect(await executeCli(["email", "doctor", "--env", "local"], output.runtime)).toBe(0);
    expect(output.stdout()).toContain("Adapter:");
  });

  it("prints local defaults from email doctor when local credentials have not been initialized", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "apps", "worker", "wrangler.jsonc"), "{}");
    const output = capture(root);
    expect(await executeCli(["email", "doctor", "--env", "local"], output.runtime)).toBe(0);
    expect(output.stdout()).toContain("API key:            not required");
    expect(output.stdout()).toContain("Local email capture requires no provider account");
    expect(output.stderr()).toBe("");
  });

  it("prints local defaults from Stripe doctor when local credentials have not been initialized", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "apps", "worker", "wrangler.jsonc"), "{}");
    await mkdir(path.join(root, "apps", "worker", "src"), { recursive: true });
    await writeFile(path.join(root, "apps", "worker", "src", "index.ts"), "// no /webhooks/stripe route yet\n");
    await mkdir(path.join(root, "packages", "billing"), { recursive: true });
    await writeFile(path.join(root, "packages", "billing", "stripe.json"), JSON.stringify({ schemaVersion: 1, currency: "usd", plans: {} }));
    const output = capture(root);
    expect(await executeCli(["payments", "stripe", "doctor", "--env", "local"], output.runtime)).toBe(0);
    expect(output.stdout()).toContain("API key:            not required");
    expect(output.stdout()).toContain("LocalBillingAdapter requires no Stripe account");
    expect(output.stderr()).toBe("");
  });

  it("does not generate application routes against a pre-registry authority model", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "packages", "context", "src"), { recursive: true });
    await writeFile(path.join(root, "packages", "context", "src", "index.ts"), 'export const authority = { plane: "organization", permissions: new Set() };\n');
    const output = capture(root);
    expect(await executeCli(["generate", "resource", "Article"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("authority model 3");
  });

  it("does not partially generate a resource when the application event catalog cannot be updated safely", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["generate", "resource", "Article"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("application event catalog registration anchors");
    await expect(readFile(path.join(root, ".trestle/resources/article.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects duplicate or unknown public webhook event selections before changing project source", async () => {
    const root = await fixture();
    for (const kinds of [["created", "created"], ["paid"]]) {
      const output = capture(root);
      expect(await executeCli(["generate", "resource", "Article", "--webhook-event", ...kinds], output.runtime)).toBe(1);
      expect(output.stderr()).toContain("--webhook-event accepts");
    }
    await expect(readFile(path.join(root, ".trestle/resources/article.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes a converged starter plan once", async () => {
    const root = await fixture();
    const manifestPath = path.join(root, ".trestle", "project.yaml");
    await writeFile(manifestPath, `${await readFile(manifestPath, "utf8")}secrets:\n  DATABASE_ADMIN_URL:\n    target: admin\n    required: [staging, production]\n  ARTIFACT_SIGNING_SECRET:\n    target: worker\n    required: []\n`);
    const init = capture(root);
    expect(await executeCli(["plan", "init"], init.runtime)).toBe(0);
    expect(init.stdout()).toContain(".trestle/setup.json");
    const plan = JSON.parse(await readFile(path.join(root, ".trestle", "setup.json"), "utf8"));
    expect(plan.apps.admin).toBe(false);
    expect(plan.secrets).toContainEqual({ name: "DATABASE_ADMIN_URL", target: "admin", required: ["staging", "production"] });
    expect(plan.secrets).toContainEqual({ name: "ARTIFACT_SIGNING_SECRET", target: "worker", required: [] });
    const validate = capture(root);
    expect(await executeCli(["plan", "validate", ".trestle/setup.json"], validate.runtime), validate.stderr()).toBe(0);
    const diff = capture(root);
    expect(await executeCli(["plan", "diff", ".trestle/setup.json"], diff.runtime)).toBe(0);
    expect(diff.stdout()).toContain("Plan converged.");
    const again = capture(root);
    expect(await executeCli(["plan", "init"], again.runtime)).toBe(1);
    expect(again.stderr()).toContain("already exists");
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

  it("fails closed when a project has no migration journal and emits structured audit evidence", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["upgrade", "migrations", "--json"], output.runtime)).toBe(1);
    const document = JSON.parse(output.stdout()) as { schemaVersion: number; data: { classification: string; requiresReview: boolean; issues: string[] } };
    expect(document.schemaVersion).toBe(1);
    expect(document.data.classification).toBe("invalid");
    expect(document.data.requiresReview).toBe(true);
    expect(document.data.issues[0]).toContain("application:");
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

  it("requires the rendered preview config to name the exact Worker before reading secrets", async () => {
    const root = await fixture();
    const missing = capture(root);
    expect(await executeCli(["secrets", "push", "--env", "preview", "--worker-name", "fixture-worker-pr-42"], missing.runtime)).toBe(1);
    expect(missing.stderr()).toContain("both --worker-name and --worker-config");
    const escaped = capture(root);
    expect(await executeCli(["secrets", "push", "--env", "preview", "--worker-name", "fixture-worker-pr-42", "--worker-config", "../other.jsonc"], escaped.runtime)).toBe(1);
    expect(escaped.stderr()).toContain("JSONC file in the Worker package");
    await writeFile(path.join(root, "apps", "worker", ".trestle-queues.wrangler.jsonc"), JSON.stringify({ env: { preview: { name: "another-worker" } } }));
    const mismatch = capture(root);
    expect(await executeCli(["secrets", "push", "--env", "preview", "--worker-name", "fixture-worker-pr-42", "--worker-config", ".trestle-queues.wrangler.jsonc"], mismatch.runtime)).toBe(1);
    expect(mismatch.stderr()).toContain("does not match the requested isolated Worker");
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

  it("requires an explicit opt-in for experimental commands", async () => {
    const shellOptIn = process.env.TRESTLE_EXPERIMENTAL;
    delete process.env.TRESTLE_EXPERIMENTAL;
    onTestFinished(() => {
      if (shellOptIn === undefined) delete process.env.TRESTLE_EXPERIMENTAL;
      else process.env.TRESTLE_EXPERIMENTAL = shellOptIn;
    });
    const root = await fixture();
    const blocked = capture(root);
    expect(await executeCli(["workflow", "retry", "publish", "instance-1", "--env", "production"], blocked.runtime)).toBe(1);
    expect(blocked.stderr()).toContain("workflow is experimental in beta");
    expect(blocked.stderr()).not.toContain("requires --yes");
    expect(blocked.stderr()).toContain("--experimental");
    expect(blocked.stderr()).toContain("TRESTLE_EXPERIMENTAL=1");
    for (const argv of [
      ["queue", "dlq", "list", "--env", "staging"],
      ["backup", "status", "--env", "production"],
      ["restore", "create", "--env", "production", "--to", "restore-test"],
      ["console", "--tenant", "acme"],
      ["admin", "grant", "ops@example.test", "security_admin", "--env", "local", "--reason", "bootstrap"],
      ["payments", "stripe", "sync", "--env", "staging"],
      ["payments", "stripe", "seed", "--organization", "org-1"],
    ]) {
      const output = capture(root);
      expect(await executeCli(argv, output.runtime), argv.join(" ")).toBe(1);
      expect(output.stderr(), argv.join(" ")).toContain("is experimental in beta");
    }
    const stable = capture(root);
    await executeCli(["payments", "stripe", "webhook", "configure", "--env", "production", "--url", "https://example.test/webhooks/stripe", "--api-key-stdin", "--apply", "--operation-id", "operation123"], stable.runtime);
    expect(stable.stderr()).not.toContain("is experimental in beta");
    const help = capture(root);
    await executeCli(["--help"], help.runtime);
    for (const name of ["queue", "workflow", "backup", "restore", "console", "admin"]) expect(help.stdout()).toMatch(new RegExp(`\\n\\s+${name}\\b[^\\n]*\\[experimental\\]`, "u"));
    expect(help.stdout()).not.toMatch(/\n\s+payments\b[^\n]*\[experimental\]/u);
    const stripeHelp = capture(root);
    await executeCli(["payments", "stripe", "--help"], stripeHelp.runtime);
    expect(stripeHelp.stdout()).toMatch(/\n\s+sync\b[^\n]*\[experimental\]/u);
    expect(stripeHelp.stdout()).toMatch(/\n\s+seed\b[^\n]*\[experimental\]/u);
    expect(stripeHelp.stdout()).not.toMatch(/\n\s+doctor\b[^\n]*\[experimental\]/u);
    const flagFirst = capture(root);
    expect(await executeCli(["--experimental", "workflow", "retry", "publish", "instance-1", "--env", "production"], flagFirst.runtime)).toBe(1);
    expect(flagFirst.stderr()).toContain("requires --yes");
    const flagAfter = capture(root);
    expect(await executeCli(["queue", "prune", "--env", "local", "--before", "2026-01-01T00:00:00Z", "--experimental"], flagAfter.runtime)).toBe(1);
    expect(flagAfter.stderr()).toContain("local outbox retention");
    const fromEnvironment = capture(root);
    const environment = (name: string) => (name === "TRESTLE_EXPERIMENTAL" ? "1" : undefined);
    expect(await executeCli(["payments", "stripe", "seed", "--organization", "org-1"], { ...fromEnvironment.runtime, environment })).toBe(1);
    expect(fromEnvironment.stderr()).toContain("requires --cookie-stdin");
  });

  it("requires an authenticated local session before seeding billing", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["--experimental", "payments", "stripe", "seed", "--organization", "org-1"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("requires --cookie-stdin");
  });

  it("requires an explicit console authority plane", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["--experimental", "console"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("requires --tenant or --platform-admin");
    const mixed = capture(root);
    expect(await executeCli(["--experimental", "console", "--tenant", "acme", "--platform-admin"], mixed.runtime)).toBe(1);
    expect(mixed.stderr()).toContain("different authority planes");
  });

  it("refuses platform admin operations until the admin capability is enabled", async () => {
    const root = await fixture();
    const output = capture(root);
    expect(await executeCli(["--experimental", "admin", "grant", "ops@example.test", "security_admin", "--env", "local", "--reason", "bootstrap"], output.runtime)).toBe(1);
    expect(output.stderr()).toContain("platform admin is not enabled");
    const missingReason = capture(root);
    expect(await executeCli(["--experimental", "admin", "revoke", "ops@example.test", "security_admin", "--env", "local"], missingReason.runtime)).toBe(1);
  });

  it("validates outbox retention cutoffs and limits before reading secrets", async () => {
    const root = await fixture();
    const local = capture(root);
    expect(await executeCli(["--experimental", "queue", "prune", "--env", "local", "--before", "2026-01-01T00:00:00Z"], local.runtime)).toBe(1);
    expect(local.stderr()).toContain("local outbox retention");
    const cutoff = capture(root);
    expect(await executeCli(["--experimental", "queue", "prune", "--env", "staging", "--before", "2026-01-01"], cutoff.runtime)).toBe(1);
    expect(cutoff.stderr()).toContain("--before must be an ISO UTC timestamp");
    const limit = capture(root);
    expect(await executeCli(["--experimental", "queue", "prune", "--env", "staging", "--before", "2026-01-01T00:00:00Z", "--limit", "10001"], limit.runtime)).toBe(1);
    expect(limit.stderr()).toContain("--limit must be between 1 and 10000");
    const window = capture(root);
    expect(await executeCli(["--experimental", "queue", "prune", "--env", "staging", "--before", new Date().toISOString()], window.runtime)).toBe(1);
    expect(window.stderr()).toContain("inside the 30-day provenance window; use a cutoff at or before");
  });

  it("runs DLQ commands as the migration role rather than the restricted runtime login", async () => {
    const root = await fixture();
    await initializeSecrets(root, "staging", { DATABASE_URL: "postgres://runtime@db.test/app", DATABASE_MIGRATION_URL: "postgres://migrator@db.test/app" });
    const bin = path.join(root, "bin");
    const log = path.join(root, "pnpm.log");
    await mkdir(bin);
    await writeFile(path.join(bin, "pnpm"), `#!/bin/sh\nprintf '%s %s\\n' "$DATABASE_URL" "$*" >> "${log}"\ncase "$*" in *" list"*) printf '[]' ;; esac\n`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    onTestFinished(() => { process.env.PATH = previousPath; });
    expect(await executeCli(["--experimental", "queue", "dlq", "list", "--env", "staging"], capture(root).runtime)).toBe(0);
    expect(await executeCli(["--experimental", "queue", "dlq", "redrive", "message-1", "--env", "staging"], capture(root).runtime)).toBe(0);
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^postgres:\/\/migrator@db\.test\/app .*outbox-admin\.ts list$/u);
    expect(calls[1]).toMatch(/^postgres:\/\/migrator@db\.test\/app .*outbox-admin\.ts redrive message-1$/u);
  });

  it("requires confirmation before creating recovery resources or retrying remote workflows", async () => {
    const root = await fixture();
    const backup = capture(root);
    expect(await executeCli(["--experimental", "backup", "verify", "--env", "production", "--to", "restore-test"], backup.runtime)).toBe(1);
    expect(backup.stderr()).toContain("temporary Neon branch");
    const restore = capture(root);
    expect(await executeCli(["--experimental", "restore", "create", "--env", "production", "--to", "restore-test"], restore.runtime)).toBe(1);
    expect(restore.stderr()).toContain("requires --yes");
    const workflow = capture(root);
    expect(await executeCli(["--experimental", "workflow", "retry", "publish", "instance-1", "--env", "production"], workflow.runtime)).toBe(1);
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
    const finalize = capture(root);
    expect(await executeCli(["upgrade", "source-finalize"], finalize.runtime)).toBe(1);
    expect(finalize.stderr()).toContain("requires --yes");
    const unsafeFinalize = capture(root);
    expect(await executeCli(["upgrade", "source-finalize", "--yes"], unsafeFinalize.runtime)).toBe(1);
    expect(unsafeFinalize.stderr()).toContain("matching baseline");
    const check = capture(root);
    expect(await executeCli(["upgrade", "plan", "--check"], check.runtime)).toBe(1);
    expect(check.stderr()).toContain("requires a reviewed upgrade");
    const removedAlias = capture(root);
    expect(await executeCli(["upgrade", "check"], removedAlias.runtime)).toBe(1);
    expect(removedAlias.stderr()).toContain("unknown command 'check'");
  });

  it("plans the platform admin as a scaffold, and never disables it automatically", async () => {
    const root = await fixture();
    await writeFile(path.join(root, ".trestle", "framework.json"), JSON.stringify({ schemaVersion: 1, templateVersion: "0.1.0-alpha.1" }));
    const plan = {
      schemaVersion: 1,
      minimumTrestleVersion: TRESTLEJS_VERSION,
      project: { name: "fixture" },
      apps: { site: false, app: true, worker: true },
      tenancy: { model: "organization", enforcement: "postgres-rls" },
      database: { engine: "postgresql", provider: "neon" },
      capabilities: { r2: true, queues: true, workflows: true, durableObjects: true, admin: true },
      integrations: { email: false, billing: false },
      environments: ["local", "preview", "staging", "production"],
      secrets: [],
      resources: [],
    };
    await writeFile(path.join(root, ".trestle", "setup.json"), JSON.stringify(plan));
    const diff = capture(root);
    expect(await executeCli(["plan", "diff", ".trestle/setup.json", "--json"], diff.runtime)).toBe(0);
    const items = JSON.parse(diff.stdout()).data.items as Array<{ id: string; classification: string }>;
    expect(items).toContainEqual(expect.objectContaining({ id: "capabilities.admin", classification: "create" }));
    expect(items).toContainEqual(expect.objectContaining({ id: "capabilities", classification: "already correct" }));
    const manifest = await readFile(path.join(root, ".trestle", "project.yaml"), "utf8");
    const stale = capture(root);
    expect(await executeCli(["apply", ".trestle/setup.json", "--yes"], stale.runtime)).toBe(1);
    expect(stale.stderr()).toContain("Run trestle upgrade first");
    expect(await readFile(path.join(root, ".trestle", "project.yaml"), "utf8")).toBe(manifest);

    await writeFile(path.join(root, ".trestle", "project.yaml"), manifest.replace("  worker: apps/worker\n", "  worker: apps/worker\n  admin: apps/admin\n").replace("  admin: false", "  admin: true"));
    await writeFile(path.join(root, ".trestle", "setup.json"), JSON.stringify({ ...plan, capabilities: { ...plan.capabilities, admin: false } }));
    const disable = capture(root);
    expect(await executeCli(["apply", ".trestle/setup.json", "--yes"], disable.runtime)).toBe(1);
    expect(disable.stderr()).toContain("delete capabilities.admin");
    await mkdir(path.join(root, "apps", "admin"), { recursive: true });
    const status = capture(root);
    expect(await executeCli(["env", "status", "--env", "staging", "--json"], status.runtime), status.stderr()).toBe(0);
    expect(JSON.parse(status.stdout()).data.requiredVariables).toEqual(["ADMIN_API_URL", "ADMIN_URL", "API_URL", "APP_URL", "DATABASE_ADMIN_RUNTIME_ROLE", "DATABASE_RUNTIME_ROLE", "SITE_URL"]);
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
      "packages/events/src",
      "apps/worker/src",
      "apps/app/src",
    ]) await mkdir(path.join(root, directory), { recursive: true });
    for (const file of [
      "packages/contracts/src/index.ts",
      "packages/domain/src/index.ts",
      "packages/data/src/index.ts",
      "packages/db/src/index.ts",
    ]) await writeFile(path.join(root, file), "export {};\n");
    await writeFile(path.join(root, "packages/events/src/application-catalog.ts"), `import { z } from "zod";
import { defineEvent, defineEventCatalog } from "./catalog.js";
// trestle:resource-event-definitions
export const applicationEventCatalog = defineEventCatalog([
  // trestle:resource-event-list
]);
`);
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
      resources: [{ name: "Article", tenant: true, crud: true, webhookEvents: ["created", "updated"] }],
    };
    const planPath = path.join(root, ".trestle", "setup.json");
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);

    const validate = capture(root);
    expect(await executeCli(["plan", "validate", ".trestle/setup.json"], validate.runtime)).toBe(0);
    expect(validate.stdout()).toContain("contains no plaintext secret values");
    await writeFile(path.join(root, ".trestle", "future.json"), `${JSON.stringify({ ...plan, minimumTrestleVersion: "0.2.0" }, null, 2)}\n`);
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
    expect(eventSource).toContain('name: "resource.article.updated"');
    expect(eventSource).toContain('name: "resource.article.deleted"');
    expect(eventSource).toContain('applicationEventCatalog.parse("resource.article.created", 1, payload)');
    expect(eventSource).toContain("{ resourceId: string }");
    expect(eventSource).not.toContain("payload.organizationId");
    const catalogSource = await readFile(path.join(root, "packages/events/src/application-catalog.ts"), "utf8");
    expect(catalogSource).toContain('name: "resource.article.created", schemaVersion: 1');
    expect(catalogSource).toContain('name: "resource.article.updated", schemaVersion: 1');
    expect(catalogSource).toContain('name: "resource.article.deleted", schemaVersion: 1');
    expect(catalogSource).toContain("  articleCreatedApplicationEvent,");
    expect(catalogSource).toContain('type: "resource.article.created", version: 1');
    expect(catalogSource).toContain('type: "resource.article.updated", version: 1');
    expect(catalogSource).not.toContain('type: "resource.article.deleted", version: 1');
    expect(await readFile(path.join(root, "packages/events/src/resources/article-webhooks.test.ts"), "utf8")).toContain("public webhook contract");
    const workerSource = await readFile(path.join(root, "apps/worker/src/index.ts"), "utf8");
    expect(workerSource).toContain('eventConsumers.register(articleCreatedEvent, handleArticleCreated, { authority: "tenant" });');
    expect(workerSource).toContain('eventConsumers.register(articleUpdatedEvent, handleArticleUpdated, { authority: "tenant" });');
    expect(workerSource).toContain('eventConsumers.register(articleDeletedEvent, handleArticleDeleted, { authority: "tenant" });');
    expect(eventSource).toContain('import type { EventHandlerContext } from "../async-runtime.js";');
    expect(eventSource).toContain("envelope: EventEnvelope, _environment: unknown, context: EventHandlerContext): Promise<void>");
    expect(eventSource).toContain("context.log.info(");
    expect(eventSource).toContain("organizationId: context.organizationId");
    expect(eventSource).not.toContain("createLogger");
    const repositorySource = await readFile(path.join(root, "packages/data/src/resources/article-repository.ts"), "utf8");
    expect(repositorySource).toContain("eq(article.organizationId, this.organizationId)");
    expect(repositorySource).toContain('transaction.execute(this.events.statement("resource.article.created", { resourceId: record.id }');
    expect(repositorySource).toContain('transaction.execute(this.events.statement("resource.article.updated", { resourceId: record.id, revision: record.revision }');
    expect(repositorySource).toContain('transaction.execute(this.events.statement("resource.article.deleted", { resourceId: record.id, revision: record.revision }');
    expect(repositorySource).not.toContain("outboxMessage");
    const screenSource = await readFile(path.join(root, "apps/app/src/resources/article.tsx"), "utf8");
    expect(screenSource).toContain('const key = ["articles", session?.user.id, organizationId] as const');
    expect(screenSource).toContain('enabled: Boolean(session?.user.id && organizationId)');
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

    const workerPath = path.join(root, "apps/worker/src/index.ts");
    const legacyWorker = workerSource.replace(/, \{ authority: "tenant" \}\);/gu, ");");
    expect(legacyWorker).toContain("eventConsumers.register(articleCreatedEvent, handleArticleCreated);");
    await writeFile(workerPath, legacyWorker);
    expect(await executeCli(["generate", "resource", "Article", "--webhook-event", "created", "updated"], capture(root).runtime)).toBe(0);
    const regenerated = await readFile(workerPath, "utf8");
    expect(regenerated.match(/eventConsumers\.register\(articleCreatedEvent,/gu)).toHaveLength(1);
    expect(regenerated.match(/eventConsumers\.register\(articleDeletedEvent,/gu)).toHaveLength(1);
    await writeFile(workerPath, workerSource);

    const catalogPath = path.join(root, "packages/events/src/application-catalog.ts");
    const currentCatalog = await readFile(catalogPath, "utf8");
    const legacyCatalog = currentCatalog
      .replace(/export const articleUpdatedApplicationEvent = defineEvent\(\{[\s\S]*?\n\}\);\n/u, "")
      .replace(/export const articleDeletedApplicationEvent = defineEvent\(\{[\s\S]*?\n\}\);\n/u, "")
      .replace("  articleUpdatedApplicationEvent,\n", "")
      .replace("  articleDeletedApplicationEvent,\n", "");
    await writeFile(catalogPath, legacyCatalog);
    expect(await executeCli(["generate", "resource", "Article", "--webhook-event", "created", "updated"], capture(root).runtime)).toBe(0);
    const legacyRepositoryPath = path.join(root, "packages/data/src/resources/article-repository.ts");
    const currentRepository = await readFile(legacyRepositoryPath, "utf8");
    await rm(legacyRepositoryPath);
    const legacyRepair = capture(root);
    expect(await executeCli(["generate", "resource", "Article", "--webhook-event", "created", "updated"], legacyRepair.runtime)).toBe(1);
    expect(legacyRepair.stderr()).toContain("create-only event contract");
    await expect(readFile(legacyRepositoryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(legacyRepositoryPath, currentRepository);
    await writeFile(catalogPath, currentCatalog);

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

    const orphan = capture(root);
    expect(await executeCli(["generate", "resource", "Comment", "--field", "ghostId:relation?:Ghost:set-null"], orphan.runtime)).toBe(1);
    expect(orphan.stderr()).toContain("not a generated tenant or shared resource");
    await expect(readFile(path.join(root, ".trestle/resources/comment.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await executeCli(["generate", "resource", "Comment", "--field", "articleId:relation?:Article:cascade"], capture(root).runtime)).toBe(0);
    expect(await readFile(path.join(root, "packages/db/src/comment-schema.ts"), "utf8")).toContain('foreignKey({ name: "comment_article_id_tenant_fk", columns: [table.organizationId, table.articleId], foreignColumns: [article.organizationId, article.id] }).onDelete("cascade")');
    expect(await readFile(path.join(root, "packages/db/src/article-schema.ts"), "utf8")).toContain('unique("article_tenant_key").on(table.organizationId, table.id)');

    expect(await executeCli(["generate", "resource", "Product", "--field", "meta:json?", "price:decimal(10,2)?", "status:enum(draft|published)?"], capture(root).runtime)).toBe(0);
    const productSchema = await readFile(path.join(root, "packages/db/src/product-schema.ts"), "utf8");
    expect(productSchema).toContain('import type { JsonValue } from "./json-value.js";');
    expect(productSchema).toContain('meta: jsonb("meta").$type<JsonValue>(),');
    expect(productSchema).toContain('price: numeric("price", { precision: 10, scale: 2 }),');
    expect(productSchema).toContain('status: text("status", { enum: ["draft", "published"] }),');
    expect(productSchema).toContain("check(\"product_status_values\", sql`${table.status} in ('draft', 'published')`),");
    expect(await readFile(path.join(root, "packages/db/src/json-value.ts"), "utf8")).toContain("export type JsonValue");
    const productContract = await readFile(path.join(root, "packages/contracts/src/resources/product.ts"), "utf8");
    expect(productContract).toContain("price: z.string().regex(/^-?\\d{1,8}(\\.\\d{1,2})?$/u).optional(),");
    expect(productContract).toContain('status: z.enum(["draft", "published"]).optional(),');
    const productRepository = await readFile(path.join(root, "packages/data/src/resources/product-repository.ts"), "utf8");
    expect(productRepository).toContain("${JSON.stringify(input.meta)}::jsonb");
    expect(productRepository).toContain("updatedAt: this.clock.now()");

    const articleDomain = await readFile(path.join(root, "packages/domain/src/resources/article.ts"), "utf8");
    expect(articleDomain).toContain("export class ArticleRevisionConflictError extends Error");
    expect(articleDomain).toContain("update(id: string, input: UpdateArticle, options?: ArticleWriteOptions): Promise<Article | null>;");
    expect(articleDomain).toContain("remove(id: string, options?: ArticleWriteOptions): Promise<boolean>;");
    const articleRepository = await readFile(path.join(root, "packages/data/src/resources/article-repository.ts"), "utf8");
    expect(articleRepository).toContain("eq(article.revision, options.expectedRevision)");
    expect(articleRepository).toContain("throw new ArticleRevisionConflictError(current.revision)");
    const articleRoutes = await readFile(path.join(root, "apps/worker/src/resources/article-routes.ts"), "utf8");
    expect(articleRoutes).toContain('expectedRevision(context.req.header("if-match"))');
    expect(articleRoutes).toContain('error: "revision_conflict"');
    expect(articleRoutes).toContain(", 409)");
    const articleContract = await readFile(path.join(root, "packages/contracts/src/resources/article.ts"), "utf8");
    expect(articleContract).toContain("export const articleApiOperations = [");
    expect(articleContract).toContain('operationId: "updateArticle"');
    expect(articleContract).toContain("errors: [404, 409]");
    const articleApi = await readFile(path.join(root, "apps/app/src/api/article.ts"), "utf8");
    expect(articleApi).toContain('"if-match": `"${options.expectedRevision}"`');
    const articleEvents = await readFile(path.join(root, "packages/data/src/resources/article-events.integration.test.ts"), "utf8");
    expect(articleEvents).toContain("rejects stale revisions without writing");

    const noRegistry = capture(root);
    expect(await executeCli(["generate", "resource", "Crop", "--shared"], noRegistry.runtime)).toBe(1);
    expect(noRegistry.stderr()).toContain("packages/authz/src/permissions.ts");
    await mkdir(path.join(root, "packages/authz/src"), { recursive: true });
    await writeFile(path.join(root, "packages/authz/src/permissions.ts"), 'export const permissions = definePermissions({\n  "resource.read": { plane: "application", description: "Read" },\n});\n');
    expect(await executeCli(["generate", "resource", "Crop", "--shared", "--field", "family:string?"], capture(root).runtime)).toBe(0);
    const cropDeclaration = JSON.parse(await readFile(path.join(root, ".trestle/resources/crop.json"), "utf8"));
    expect(cropDeclaration).toMatchObject({ tenant: false, authorization: { read: "resource.read", write: "platform.crops.manage" } });
    const cropSchema = await readFile(path.join(root, "packages/db/src/crop-schema.ts"), "utf8");
    expect(cropSchema).not.toContain("organizationId");
    expect(cropSchema).toContain('pgPolicy("crop_tenant_read", { as: "permissive", for: "select", to: "trestle_app", using: sql`true` })');
    expect(cropSchema).toContain('pgPolicy("crop_platform_manage", { as: "permissive", for: "all", to: "trestle_platform", using: sql`true`, withCheck: sql`true` })');
    expect(await readFile(path.join(root, "packages/authz/src/permissions.ts"), "utf8")).toContain('"platform.crops.manage": { plane: "platform", description: "Create, update, and delete shared Crop records" },');
    const cropRoutes = await readFile(path.join(root, "apps/worker/src/resources/crop-routes.ts"), "utf8");
    expect(cropRoutes).toContain('access.require({ permission: "resource.read" })');
    expect(cropRoutes).not.toMatch(/cropRoutes\.(post|patch|put|delete)\(/u);
    const cropEditor = await readFile(path.join(root, "packages/db/src/crop-editor.ts"), "utf8");
    expect(cropEditor).toContain('"platform.crop.updated"');
    expect(cropEditor).toContain("eq(crop.revision, input.expectedRevision)");
    expect(await readFile(path.join(root, "packages/db/src/index.ts"), "utf8")).toContain('export * from "./crop-editor.js";');

    expect(await executeCli(["generate", "resource", "Planting", "--field", "cropId:relation?:Crop:restrict"], capture(root).runtime)).toBe(0);
    expect(await readFile(path.join(root, "packages/db/src/planting-schema.ts"), "utf8")).toContain('foreignKey({ name: "planting_crop_id_shared_fk", columns: [table.cropId], foreignColumns: [crop.id] }).onDelete("restrict"),');
    expect(await readFile(path.join(root, "packages/db/src/crop-schema.ts"), "utf8")).toBe(cropSchema);
    const sharedToTenant = capture(root);
    expect(await executeCli(["generate", "resource", "Variety", "--shared", "--field", "plantingId:relation?:Planting:restrict"], sharedToTenant.runtime)).toBe(1);
    expect(sharedToTenant.stderr()).toContain("shared resources cannot reference tenant resource Planting");
  });
});
