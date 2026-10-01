import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyLocalEdit, commitSnapshot, CredentialError, decryptSnapshot, encryptSnapshot, importDotenvOutputs, mergeProviderValues, parseDotenv,
  readCommittedSnapshot, removeAdapterOutput, rotateSnapshotKey, snapshotScopeKey, type CredentialMetadata, type OutputMapping, type SnapshotScope,
} from "../src/infra/credentials.js";
import { MemoryOperationStore } from "../src/infra/stores/memory.js";
import { decryptSecrets, encryptSecrets } from "../src/secrets.js";

const now = new Date("2026-10-02T00:00:00.000Z");
const masterKey = randomBytes(32).toString("hex");
const scope: SnapshotScope = { projectId: "trestle-proj-1", environment: "staging", purpose: "deployment" };
const meta = (name: string, classification: CredentialMetadata["classification"] = "provider-managed", override = false): CredentialMetadata => ({ name, classification, binding: classification === "application-owned" ? null : "database-runtime", provider: classification === "application-owned" ? null : "neon", resource: classification === "application-owned" ? null : "neon-proj-1", consumers: ["worker"], importedAt: now.toISOString(), override });
const SECRET = "postgres://runtime:s3cr3t-value@ep-1.neon.tech/db?sslmode=require";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("version 2 credential envelope", () => {
  it("round-trips and keeps values out of the envelope's readable fields", () => {
    const envelope = encryptSnapshot({ DATABASE_URL: SECRET }, [meta("DATABASE_URL")], scope, 1, masterKey);
    expect(JSON.stringify(envelope)).not.toContain("s3cr3t-value");
    expect(decryptSnapshot(envelope, { ...scope, minimumGeneration: 1 }, masterKey).values).toEqual({ DATABASE_URL: SECRET });
  });

  it("rejects substitution across project, environment, purpose and generation (AR-04)", () => {
    const envelope = encryptSnapshot({ DATABASE_URL: SECRET }, [meta("DATABASE_URL")], scope, 2, masterKey);
    for (const other of [{ projectId: "trestle-proj-2" }, { environment: "production" }, { purpose: "operator" as const }]) {
      expect(() => decryptSnapshot(envelope, { ...scope, ...other, minimumGeneration: 0 }, masterKey)).toThrow(/different project, environment or purpose/u);
      // Rewriting the header to match fails authentication because the header is bound as AAD.
      expect(() => decryptSnapshot({ ...envelope, ...other }, { ...scope, ...other, minimumGeneration: 0 }, masterKey)).toThrow(/failed authentication/u);
    }
    expect(() => decryptSnapshot(envelope, { ...scope, minimumGeneration: 3 }, masterKey)).toThrow(/older than the committed generation/u);
    expect(() => decryptSnapshot({ ...envelope, generation: 3 }, { ...scope, minimumGeneration: 3 }, masterKey)).toThrow(/failed authentication/u);
  });

  it("authenticates metadata, nonce, tag and ciphertext", () => {
    const envelope = encryptSnapshot({ DATABASE_URL: SECRET }, [meta("DATABASE_URL")], scope, 1, masterKey);
    const flip = (value: string) => Buffer.from(Buffer.from(value, "base64").map((byte, index) => (index === 0 ? byte ^ 1 : byte))).toString("base64");
    for (const tampered of [{ ciphertext: flip(envelope.ciphertext) }, { tag: flip(envelope.tag) }, { nonce: flip(envelope.nonce) }, { metadata: [{ ...envelope.metadata[0]!, consumers: ["worker", "admin"] }] }]) {
      expect(() => decryptSnapshot({ ...envelope, ...tampered }, { ...scope, minimumGeneration: 1 }, masterKey)).toThrow(/failed authentication/u);
    }
    expect(() => decryptSnapshot(envelope, { ...scope, minimumGeneration: 1 }, randomBytes(32).toString("hex"))).toThrow(/failed authentication/u);
    expect(() => encryptSnapshot({ A: "1" }, [], scope, 1, masterKey)).toThrow(/metadata entry/u);
  });

  it("is rejected by the version 1 reader, so an old CLI cannot downgrade it, and v1 files stay readable", () => {
    const envelope = encryptSnapshot({ DATABASE_URL: SECRET }, [meta("DATABASE_URL")], scope, 1, masterKey);
    expect(() => decryptSecrets(JSON.stringify(envelope), "staging", masterKey)).toThrow(/Unsupported encrypted credentials format/u);
    expect(decryptSecrets(encryptSecrets({ LEGACY: "value" }, "staging", masterKey), "staging", masterKey)).toEqual({ LEGACY: "value" });
    expect(() => decryptSnapshot(JSON.parse(encryptSecrets({ LEGACY: "value" }, "staging", masterKey)), { ...scope, minimumGeneration: 0 }, masterKey)).toThrow(/not a version 2/u);
  });
});

describe("generation commits", () => {
  it("commits by compare-and-swap so stale pulls and concurrent edits cannot overwrite (AR-04)", async () => {
    const store = new MemoryOperationStore();
    expect(await commitSnapshot(store, scope, 0, { DATABASE_URL: SECRET }, [meta("DATABASE_URL")], masterKey)).toBe(1);
    const base = await readCommittedSnapshot(store, scope, masterKey);
    expect(await commitSnapshot(store, scope, base.generation, { DATABASE_URL: `${SECRET}&v=2` }, [meta("DATABASE_URL")], masterKey)).toBe(2);
    // A concurrent writer that read generation 1 loses.
    await expect(commitSnapshot(store, scope, base.generation, { DATABASE_URL: "stale" }, [meta("DATABASE_URL")], masterKey)).rejects.toThrow(/generation conflict/u);
    expect((await readCommittedSnapshot(store, scope, masterKey)).values.DATABASE_URL).toBe(`${SECRET}&v=2`);
  });

  it("refuses a committed envelope whose digest or generation was altered in the store", async () => {
    const store = new MemoryOperationStore();
    await commitSnapshot(store, scope, 0, { DATABASE_URL: SECRET }, [meta("DATABASE_URL")], masterKey);
    const older = encryptSnapshot({ DATABASE_URL: "old" }, [meta("DATABASE_URL")], scope, 1, masterKey);
    const snapshot = await store.exportState();
    const restored = new MemoryOperationStore();
    await restored.importState({ ...snapshot, generations: snapshot.generations.map((generation) => ({ ...generation, data: { envelope: older } })) });
    await expect(readCommittedSnapshot(restored, scope, masterKey)).rejects.toThrow(/does not match its recorded digest/u);
  });

  it("re-encrypts under a new master key as a new generation, distinct from provider rotation", async () => {
    const store = new MemoryOperationStore();
    await commitSnapshot(store, scope, 0, { DATABASE_URL: SECRET }, [meta("DATABASE_URL")], masterKey);
    const newKey = randomBytes(32).toString("hex");
    expect(await rotateSnapshotKey(store, scope, masterKey, newKey)).toBe(2);
    expect((await readCommittedSnapshot(store, scope, newKey)).values).toEqual({ DATABASE_URL: SECRET });
    await expect(readCommittedSnapshot(store, scope, masterKey)).rejects.toThrow(/failed authentication/u);
  });

  it("validates scope parts used in store keys", () => {
    expect(snapshotScopeKey(scope)).toBe("credentials:trestle-proj-1:staging:deployment");
    expect(() => snapshotScopeKey({ ...scope, projectId: "a:b" })).toThrow(CredentialError);
  });
});

describe("dotenv parsing", () => {
  it("treats shell syntax as literal data and never evaluates it", () => {
    const values = parseDotenv([
      "# comment", "", "PLAIN=value # trailing comment", 'DOUBLE="a $(touch /tmp/pwned) `id` ${HOME}"', "SINGLE='literal $HOME \\n'", 'ESCAPED="line1\\nline2 \\"q\\" \\\\"',
      'MULTI="first', 'second"', "export EXPORTED=yes", "EMPTY=",
    ].join("\n"));
    expect(values).toEqual({ PLAIN: "value", DOUBLE: "a $(touch /tmp/pwned) `id` ${HOME}", SINGLE: "literal $HOME \\n", ESCAPED: 'line1\nline2 "q" \\', MULTI: "first\nsecond", EXPORTED: "yes", EMPTY: "" });
  });

  it("rejects malformed, duplicate, unterminated, oversized and NUL content", () => {
    for (const bad of ["lowercase=1", "NO_EQUALS", "A=1\nA=2", 'A="unterminated', "A='x", 'A="x" trailing', "A=1\0", `A=${"x".repeat(70_000)}`, "-A=1", "A B=1"]) {
      expect(() => parseDotenv(bad), JSON.stringify(bad.slice(0, 30))).toThrow(CredentialError);
    }
  });
});

async function workspace(): Promise<{ root: string; project: string; output: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-cred-"));
  directories.push(root);
  const project = path.join(root, "app");
  const work = path.join(root, "workspace");
  await mkdir(project);
  await mkdir(work, { mode: 0o700 });
  return { root, project, output: path.join(work, ".env.staging") };
}

const mappings: OutputMapping[] = [{ output: "DATABASE_URL", as: "DATABASE_URL", classification: "operator-only", binding: "database-bootstrap", provider: "neon", resource: "neon-proj-1", consumers: [] }];

describe("protected credential import", () => {
  it("imports declared outputs with provenance and no values in metadata", async () => {
    const { project, output } = await workspace();
    await writeFile(output, `DATABASE_URL="${SECRET}"\n`, { mode: 0o600 });
    const imported = await importDotenvOutputs(output, path.dirname(output), mappings, { projectRoot: project, now });
    expect(imported.values).toEqual({ DATABASE_URL: SECRET });
    expect(JSON.stringify(imported.metadata)).not.toContain("s3cr3t");
    expect(imported.metadata[0]).toMatchObject({ classification: "operator-only", binding: "database-bootstrap", resource: "neon-proj-1", override: false });
  });

  it("rejects symlinks, escapes, permissive modes, the application root, missing and undeclared outputs", async () => {
    const { root, project, output } = await workspace();
    const work = path.dirname(output);
    const outside = path.join(root, "outside.env");
    await writeFile(outside, `DATABASE_URL=${SECRET}\n`, { mode: 0o600 });
    await symlink(outside, output);
    await expect(importDotenvOutputs(output, work, mappings, { projectRoot: project, now })).rejects.toThrow(/symbolic link/u);
    await expect(importDotenvOutputs(outside, work, mappings, { projectRoot: project, now })).rejects.toThrow(/outside the isolated workspace/u);
    await rm(output);
    await writeFile(output, `DATABASE_URL=${SECRET}\n`, { mode: 0o644 });
    await chmod(output, 0o644);
    await expect(importDotenvOutputs(output, work, mappings, { projectRoot: project, now })).rejects.toThrow(/readable by group or others/u);
    await chmod(output, 0o600);
    await expect(importDotenvOutputs(output, project, mappings, { projectRoot: project, now })).rejects.toThrow();
    await expect(importDotenvOutputs(path.join(project, ".env"), project, mappings, { projectRoot: project, now })).rejects.toThrow(/application root|missing/u);
    await writeFile(output, "OTHER=1\n", { mode: 0o600 });
    await expect(importDotenvOutputs(output, work, [...mappings, { ...mappings[0]!, output: "OTHER", as: "OTHER" }], { projectRoot: project, now })).rejects.toThrow(/DATABASE_URL is missing/u);
    await writeFile(output, `DATABASE_URL=${SECRET}\nSIBLING_API_KEY=rotated\n`, { mode: 0o600 });
    await expect(importDotenvOutputs(output, work, mappings, { projectRoot: project, now })).rejects.toThrow(/undeclared credential outputs: SIBLING_API_KEY/u);
    await writeFile(output, `DATABASE_URL=${SECRET}\nB=2\n`, { mode: 0o600 });
    await expect(importDotenvOutputs(output, work, [...mappings, { ...mappings[0]!, output: "B" }], { projectRoot: project, now })).rejects.toThrow(/same name/u);
  });

  it("never touches a developer .env in the application root", async () => {
    const { project, output } = await workspace();
    await writeFile(path.join(project, ".env"), "MINE=keep\n", { mode: 0o600 });
    await writeFile(output, `DATABASE_URL=${SECRET}\n`, { mode: 0o600 });
    await importDotenvOutputs(output, path.dirname(output), mappings, { projectRoot: project, now });
    expect(await removeAdapterOutput(output)).toEqual({ removed: true });
    expect(await readFile(path.join(project, ".env"), "utf8")).toBe("MINE=keep\n");
    expect(await readdir(path.dirname(output))).toEqual([]);
  });

  it("reports interrupted cleanup as debt rather than success", async () => {
    const result = await removeAdapterOutput(path.join(os.tmpdir(), `missing-${randomBytes(4).toString("hex")}`));
    expect(result).toMatchObject({ removed: false, debt: expect.stringMatching(/could not be removed/u) });
  });
});

describe("override and merge rules", () => {
  const current = { values: { DATABASE_URL: "old", APP_SECRET: "mine", OVERRIDDEN: "local" }, metadata: [meta("DATABASE_URL"), meta("APP_SECRET", "application-owned"), meta("OVERRIDDEN", "provider-managed", true)] };

  it("updates provider values, preserves application values, and demands a choice for overrides", () => {
    const incoming = { values: { DATABASE_URL: "new", OVERRIDDEN: "provider" }, metadata: [meta("DATABASE_URL"), meta("OVERRIDDEN")] };
    expect(mergeProviderValues(current, incoming)).toMatchObject({ status: "conflict", conflicts: [expect.stringMatching(/OVERRIDDEN has a local override/u)] });
    const retained = mergeProviderValues(current, incoming, { OVERRIDDEN: "retain-override" });
    expect(retained).toMatchObject({ status: "merged", values: { DATABASE_URL: "new", APP_SECRET: "mine", OVERRIDDEN: "local" }, changed: ["DATABASE_URL"] });
    const accepted = mergeProviderValues(current, incoming, { OVERRIDDEN: "accept-provider" });
    expect(accepted).toMatchObject({ status: "merged", values: { OVERRIDDEN: "provider" } });
    if (accepted.status === "merged") expect(accepted.metadata.find((entry) => entry.name === "OVERRIDDEN")?.override).toBe(false);
    const moved = mergeProviderValues(current, incoming, { OVERRIDDEN: "move-to-application" });
    if (moved.status !== "merged") throw new Error("expected merge");
    expect(moved.values.OVERRIDDEN).toBe("local");
    expect(moved.metadata.find((entry) => entry.name === "OVERRIDDEN")).toMatchObject({ classification: "application-owned", override: false });
  });

  it("never lets a provider output replace an application-owned value", () => {
    expect(mergeProviderValues(current, { values: { APP_SECRET: "provider" }, metadata: [meta("APP_SECRET")] })).toMatchObject({ status: "conflict", conflicts: [expect.stringMatching(/application-owned/u)] });
  });

  it("marks an edited provider-managed value as a visible override without changing the provider", () => {
    const edited = applyLocalEdit(current, { DATABASE_URL: "edited", APP_SECRET: "mine2", OVERRIDDEN: "local", NEW_VALUE: "x" }, now);
    expect(edited.metadata.find((entry) => entry.name === "DATABASE_URL")).toMatchObject({ override: true, classification: "provider-managed" });
    expect(edited.metadata.find((entry) => entry.name === "APP_SECRET")).toMatchObject({ override: false });
    expect(edited.metadata.find((entry) => entry.name === "NEW_VALUE")).toMatchObject({ classification: "application-owned" });
  });
});

describe("existing secret files", () => {
  it("keep their exact on-disk format", async () => {
    const { root } = await workspace();
    const file = path.join(root, "staging.yml.enc");
    await writeFile(file, encryptSecrets({ A: "1" }, "staging", masterKey));
    const envelope = JSON.parse(await readFile(file, "utf8"));
    expect(Object.keys(envelope).sort()).toEqual(["algorithm", "ciphertext", "environment", "nonce", "tag", "version"]);
    expect(envelope.version).toBe(1);
    expect((await stat(file)).isFile()).toBe(true);
  });
});
