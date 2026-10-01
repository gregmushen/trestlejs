import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { canonicalDigest, canonicalJson } from "./canonical.js";
import type { OperationStore } from "./store.js";

/**
 * Infrastructure credential snapshots (spec §15–§17, D-04): versioned,
 * project/environment/purpose/generation-bound envelopes, committed through the
 * control store by compare-and-swap, and a protected dotenv import path.
 */

export type CredentialClassification = "provider-managed" | "application-owned" | "operator-only";
export type SnapshotPurpose = "deployment" | "operator";

export type CredentialMetadata = Readonly<{
  name: string;
  classification: CredentialClassification;
  binding: string | null;
  provider: string | null;
  resource: string | null;
  consumers: readonly string[];
  importedAt: string;
  /** A local edit of a provider-managed value; never sent back to the provider. */
  override: boolean;
}>;

export type SnapshotScope = Readonly<{ projectId: string; environment: string; purpose: SnapshotPurpose }>;

export type EnvelopeV2 = Readonly<{
  schema: "trestle.credentials.v2";
  version: 2;
  algorithm: "aes-256-gcm";
  projectId: string;
  environment: string;
  purpose: SnapshotPurpose;
  generation: number;
  metadata: readonly CredentialMetadata[];
  nonce: string;
  tag: string;
  ciphertext: string;
}>;

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

function key(input: string): Buffer {
  if (!/^[a-f0-9]{64}$/iu.test(input.trim())) throw new CredentialError("master key must be exactly 64 hexadecimal characters");
  return Buffer.from(input.trim(), "hex");
}

function additionalData(envelope: Omit<EnvelopeV2, "nonce" | "tag" | "ciphertext" | "algorithm">): Buffer {
  const { schema, version, projectId, environment, purpose, generation, metadata } = envelope;
  return Buffer.from(canonicalJson({ schema, version, projectId, environment, purpose, generation, metadata }), "utf8");
}

export function snapshotScopeKey(scope: SnapshotScope): string {
  for (const part of [scope.projectId, scope.environment]) if (!/^[A-Za-z0-9_.-]{1,100}$/u.test(part)) throw new CredentialError("snapshot scope parts must be simple identifiers");
  return `credentials:${scope.projectId}:${scope.environment}:${scope.purpose}`;
}

export function encryptSnapshot(values: Readonly<Record<string, string>>, metadata: readonly CredentialMetadata[], scope: SnapshotScope, generation: number, masterKey: string): EnvelopeV2 {
  const names = Object.keys(values).sort();
  const described = metadata.map((entry) => entry.name).sort();
  if (canonicalJson(names) !== canonicalJson(described)) throw new CredentialError("every credential value needs exactly one metadata entry");
  const header = { schema: "trestle.credentials.v2" as const, version: 2 as const, projectId: scope.projectId, environment: scope.environment, purpose: scope.purpose, generation, metadata: [...metadata].sort((left, right) => left.name.localeCompare(right.name)) };
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(masterKey), nonce);
  cipher.setAAD(additionalData(header));
  const ciphertext = Buffer.concat([cipher.update(canonicalJson(values), "utf8"), cipher.final()]);
  return { ...header, algorithm: "aes-256-gcm", nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

export function decryptSnapshot(input: unknown, expected: SnapshotScope & { minimumGeneration: number }, masterKey: string): { values: Record<string, string>; envelope: EnvelopeV2 } {
  const envelope = input as Partial<EnvelopeV2>;
  if (!envelope || envelope.schema !== "trestle.credentials.v2" || envelope.version !== 2 || envelope.algorithm !== "aes-256-gcm") throw new CredentialError("not a version 2 infrastructure credential envelope");
  if (envelope.projectId !== expected.projectId || envelope.environment !== expected.environment || envelope.purpose !== expected.purpose) throw new CredentialError("credential envelope belongs to a different project, environment or purpose");
  if (typeof envelope.generation !== "number" || envelope.generation < expected.minimumGeneration) throw new CredentialError(`credential envelope generation ${String(envelope.generation)} is older than the committed generation ${expected.minimumGeneration}`);
  if (!Array.isArray(envelope.metadata) || !envelope.nonce || !envelope.tag || !envelope.ciphertext) throw new CredentialError("credential envelope is incomplete");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(masterKey), Buffer.from(envelope.nonce, "base64"));
    decipher.setAAD(additionalData(envelope as EnvelopeV2));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
    const values = JSON.parse(plaintext) as Record<string, string>;
    return { values, envelope: envelope as EnvelopeV2 };
  } catch {
    throw new CredentialError("credential envelope failed authentication: wrong key, scope, generation or tampered data");
  }
}

/** Reads the committed snapshot. Returns generation 0 and no values when none exists. */
export async function readCommittedSnapshot(store: OperationStore, scope: SnapshotScope, masterKey: string): Promise<{ generation: number; values: Record<string, string>; metadata: readonly CredentialMetadata[] }> {
  const committed = await store.readGeneration(snapshotScopeKey(scope));
  if (!committed) return { generation: 0, values: {}, metadata: [] };
  const envelope = committed.data.envelope;
  if (canonicalDigest(envelope) !== committed.payloadDigest) throw new CredentialError("committed credential envelope does not match its recorded digest");
  const { values, envelope: parsed } = decryptSnapshot(envelope, { ...scope, minimumGeneration: committed.generation }, masterKey);
  if (parsed.generation !== committed.generation) throw new CredentialError("committed envelope generation does not match the control store");
  return { generation: committed.generation, values, metadata: parsed.metadata };
}

/**
 * Commits the next generation by compare-and-swap. A stale base (an old
 * checkout, a concurrent pull or edit) fails instead of overwriting (AR-04).
 */
export async function commitSnapshot(store: OperationStore, scope: SnapshotScope, baseGeneration: number, values: Readonly<Record<string, string>>, metadata: readonly CredentialMetadata[], masterKey: string): Promise<number> {
  const envelope = encryptSnapshot(values, metadata, scope, baseGeneration + 1, masterKey);
  const committed = await store.commitGeneration(snapshotScopeKey(scope), baseGeneration, canonicalDigest(envelope), { envelope });
  return committed.generation;
}

/** Re-encrypts the committed snapshot under a new master key as the next generation. */
export async function rotateSnapshotKey(store: OperationStore, scope: SnapshotScope, oldKey: string, newKey: string): Promise<number> {
  const current = await readCommittedSnapshot(store, scope, oldKey);
  if (current.generation === 0) throw new CredentialError("no committed snapshot to re-encrypt");
  return commitSnapshot(store, scope, current.generation, current.values, current.metadata, newKey);
}

// ---------------------------------------------------------------------------
// Protected dotenv import (spec §17)

const MAX_DOTENV_BYTES = 64 * 1024;

/** Parses dotenv content strictly as data. Nothing is evaluated, expanded or executed. */
export function parseDotenv(content: string): Record<string, string> {
  if (Buffer.byteLength(content, "utf8") > MAX_DOTENV_BYTES) throw new CredentialError("credential output exceeds the size bound");
  if (content.includes("\0")) throw new CredentialError("credential output contains a NUL byte");
  const text = content.replace(/\r\n/gu, "\n");
  const values: Record<string, string> = {};
  let position = 0;
  let line = 1;
  while (position < text.length) {
    const end = text.indexOf("\n", position) === -1 ? text.length : text.indexOf("\n", position);
    const current = text.slice(position, end);
    if (/^\s*(?:#.*)?$/u.test(current)) {
      position = end + 1;
      line += 1;
      continue;
    }
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=/u.exec(current);
    if (!match) throw new CredentialError(`credential output line ${line} is malformed`);
    const name = match[1]!;
    let cursor = position + match[0].length;
    let value = "";
    const quote = text[cursor];
    if (quote === '"' || quote === "'") {
      // Quoted values may span lines; double quotes decode only \n, \" and \\.
      cursor += 1;
      let closed = false;
      while (cursor < text.length) {
        const character = text[cursor]!;
        if (quote === '"' && character === "\\" && cursor + 1 < text.length) {
          const next = text[cursor + 1]!;
          value += next === "n" ? "\n" : next === '"' || next === "\\" ? next : `\\${next}`;
          cursor += 2;
          continue;
        }
        if (character === quote) {
          closed = true;
          cursor += 1;
          break;
        }
        if (character === "\n") line += 1;
        value += character;
        cursor += 1;
      }
      if (!closed) throw new CredentialError(`credential output value ${name} has an unterminated quote`);
      const rest = text.slice(cursor, text.indexOf("\n", cursor) === -1 ? text.length : text.indexOf("\n", cursor));
      if (!/^\s*(?:#.*)?$/u.test(rest)) throw new CredentialError(`credential output value ${name} has trailing content after its closing quote`);
      cursor += rest.length;
    } else {
      value = current.slice(match[0].length).replace(/\s+#.*$/u, "").trim();
      cursor = end;
    }
    if (name in values) throw new CredentialError(`credential output defines ${name} more than once`);
    values[name] = value;
    position = cursor + 1;
    line += 1;
  }
  return values;
}

export type OutputMapping = Readonly<{ output: string; as: string; classification: CredentialClassification; binding: string; provider: string; resource: string | null; consumers: readonly string[] }>;

/**
 * Reads an adapter-owned dotenv output inside an isolated workspace. Rejects
 * symlinks, files outside the workspace, foreign ownership, permissive modes,
 * missing declared outputs, collisions, and undeclared extra outputs (AR-05).
 */
export async function importDotenvOutputs(file: string, workspace: string, mappings: readonly OutputMapping[], options: { projectRoot: string; now: Date; /** Outputs declared by other resources in the same environment: tolerated, not imported. */ siblingOutputs?: readonly string[] }): Promise<{ values: Record<string, string>; metadata: CredentialMetadata[] }> {
  const resolvedWorkspace = await realpath(workspace);
  const resolvedProject = await realpath(options.projectRoot);
  if (resolvedWorkspace === resolvedProject) throw new CredentialError("credential outputs are never read from the application root");
  const info = await lstat(file).catch(() => { throw new CredentialError("declared credential output file is missing"); });
  if (info.isSymbolicLink()) throw new CredentialError("credential output is a symbolic link");
  if (!info.isFile()) throw new CredentialError("credential output is not a regular file");
  const resolved = await realpath(file);
  if (path.relative(resolvedWorkspace, resolved).startsWith("..") || path.isAbsolute(path.relative(resolvedWorkspace, resolved))) throw new CredentialError("credential output is outside the isolated workspace");
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new CredentialError("credential output is owned by another user");
  if ((info.mode & 0o077) !== 0) throw new CredentialError("credential output is readable by group or others");
  const raw = parseDotenv(await readFile(resolved, "utf8"));
  const declared = new Set(mappings.map((mapping) => mapping.output));
  const extras = Object.keys(raw).filter((name) => !declared.has(name) && !(options.siblingOutputs ?? []).includes(name)).sort();
  if (extras.length) throw new CredentialError(`provider wrote undeclared credential outputs: ${extras.join(", ")}`);
  const targets = mappings.map((mapping) => mapping.as);
  if (new Set(targets).size !== targets.length) throw new CredentialError("two credential outputs map to the same name");
  const values: Record<string, string> = {};
  const metadata: CredentialMetadata[] = [];
  for (const mapping of mappings) {
    const value = raw[mapping.output];
    if (value === undefined || value === "") throw new CredentialError(`declared credential output ${mapping.output} is missing`);
    values[mapping.as] = value;
    metadata.push({ name: mapping.as, classification: mapping.classification, binding: mapping.binding, provider: mapping.provider, resource: mapping.resource, consumers: [...mapping.consumers], importedAt: options.now.toISOString(), override: false });
  }
  return { values, metadata };
}

/** Removes only the adapter-owned temporary file; failure is reported as cleanup debt, never as success. */
export async function removeAdapterOutput(file: string): Promise<{ removed: boolean; debt?: string }> {
  try {
    await rm(file, { force: false });
    return { removed: true };
  } catch (error) {
    return { removed: false, debt: `plaintext credential output could not be removed (${(error as NodeJS.ErrnoException).code ?? "error"}); remove it manually` };
  }
}

// ---------------------------------------------------------------------------
// Pull merge and override rules (spec §16)

export type OverrideChoice = "retain-override" | "accept-provider" | "move-to-application";

export type MergeResult =
  | Readonly<{ status: "merged"; values: Record<string, string>; metadata: CredentialMetadata[]; changed: readonly string[] }>
  | Readonly<{ status: "conflict"; conflicts: readonly string[] }>;

/**
 * Merges freshly imported provider values into the committed snapshot.
 * Application-owned values are always preserved; a local override of a
 * provider-managed value requires an explicit per-name choice. No silent
 * last-writer-wins.
 */
export function mergeProviderValues(
  current: { values: Readonly<Record<string, string>>; metadata: readonly CredentialMetadata[] },
  incoming: { values: Readonly<Record<string, string>>; metadata: readonly CredentialMetadata[] },
  choices: Readonly<Record<string, OverrideChoice>> = {},
): MergeResult {
  const values: Record<string, string> = { ...current.values };
  const metadata = new Map(current.metadata.map((entry) => [entry.name, entry]));
  const conflicts: string[] = [];
  const changed: string[] = [];
  for (const entry of incoming.metadata) {
    const existing = metadata.get(entry.name);
    const value = incoming.values[entry.name]!;
    if (existing?.classification === "application-owned") {
      conflicts.push(`${entry.name} is application-owned; a provider output cannot replace it`);
      continue;
    }
    if (existing?.override && values[entry.name] !== value) {
      const choice = choices[entry.name];
      if (!choice) {
        conflicts.push(`${entry.name} has a local override that differs from the provider value; choose retain-override, accept-provider or move-to-application`);
        continue;
      }
      if (choice === "retain-override") continue;
      if (choice === "move-to-application") {
        metadata.set(entry.name, { ...existing, classification: "application-owned", override: false, binding: null, provider: null, resource: null });
        continue;
      }
    }
    if (values[entry.name] !== value) changed.push(entry.name);
    values[entry.name] = value;
    metadata.set(entry.name, { ...entry, override: false });
  }
  if (conflicts.length) return { status: "conflict", conflicts };
  return { status: "merged", values, metadata: [...metadata.values()].sort((left, right) => left.name.localeCompare(right.name)), changed: changed.sort() };
}

/** Applies an editor change: editing a provider-managed value marks it as a visible local override. */
export function applyLocalEdit(current: { values: Readonly<Record<string, string>>; metadata: readonly CredentialMetadata[] }, edited: Readonly<Record<string, string>>, now: Date): { values: Record<string, string>; metadata: CredentialMetadata[] } {
  const metadata: CredentialMetadata[] = [];
  for (const [name, value] of Object.entries(edited)) {
    const existing = current.metadata.find((entry) => entry.name === name);
    if (!existing) {
      metadata.push({ name, classification: "application-owned", binding: null, provider: null, resource: null, consumers: [], importedAt: now.toISOString(), override: false });
      continue;
    }
    const changedProviderValue = existing.classification !== "application-owned" && current.values[name] !== value;
    metadata.push({ ...existing, override: existing.override || changedProviderValue });
  }
  return { values: { ...edited }, metadata: metadata.sort((left, right) => left.name.localeCompare(right.name)) };
}
