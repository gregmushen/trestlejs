import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { EnvironmentName, ProjectManifest } from "@trestlejs/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type SecretValues = Record<string, string>;

type Envelope = {
  version: 1;
  environment: EnvironmentName;
  algorithm: "aes-256-gcm";
  nonce: string;
  tag: string;
  ciphertext: string;
};

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsError";
  }
}

export function credentialsPaths(root: string, environment: EnvironmentName) {
  const config = path.join(root, "config");
  if (environment === "local") {
    return {
      encrypted: path.join(config, "credentials.yml.enc"),
      key: path.join(config, "master.key"),
    };
  }
  return {
    encrypted: path.join(config, "credentials", `${environment}.yml.enc`),
    key: path.join(config, "credentials", `${environment}.key`),
  };
}

function parseKey(input: string): Buffer {
  const value = input.trim();
  if (!/^[a-f0-9]{64}$/iu.test(value)) {
    throw new SecretsError("Master key must be exactly 64 hexadecimal characters");
  }
  return Buffer.from(value, "hex");
}

function aad(environment: EnvironmentName): Buffer {
  return Buffer.from(`trestle-credentials:v1:${environment}`, "utf8");
}

export function parseSecretDocument(input: string): SecretValues {
  let document: unknown;
  try {
    document = parseYaml(input);
  } catch (error) {
    throw new SecretsError(`Credentials are not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (document === null) return {};
  if (typeof document !== "object" || Array.isArray(document)) {
    throw new SecretsError("Credentials must be a YAML mapping");
  }
  const values: SecretValues = {};
  for (const [name, value] of Object.entries(document)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || typeof value !== "string") {
      throw new SecretsError(`Credential ${name} must have an uppercase name and string value`);
    }
    values[name] = value;
  }
  return values;
}

export function formatSecretDocument(values: SecretValues): string {
  const sorted = Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)));
  return stringifyYaml(sorted, { lineWidth: 0 });
}

export function encryptSecrets(values: SecretValues, environment: EnvironmentName, keyInput: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", parseKey(keyInput), nonce);
  cipher.setAAD(aad(environment));
  const ciphertext = Buffer.concat([cipher.update(formatSecretDocument(values), "utf8"), cipher.final()]);
  const envelope: Envelope = {
    version: 1,
    environment,
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return `${JSON.stringify(envelope)}\n`;
}

export function decryptSecrets(input: string, environment: EnvironmentName, keyInput: string): SecretValues {
  let envelope: Partial<Envelope>;
  try {
    envelope = JSON.parse(input) as Partial<Envelope>;
  } catch {
    throw new SecretsError("Encrypted credentials envelope is not valid JSON");
  }
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new SecretsError("Unsupported encrypted credentials format");
  }
  if (envelope.environment !== environment) {
    throw new SecretsError(`Credentials belong to ${String(envelope.environment)}, not ${environment}`);
  }
  if (!envelope.nonce || !envelope.tag || !envelope.ciphertext) {
    throw new SecretsError("Encrypted credentials envelope is incomplete");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", parseKey(keyInput), Buffer.from(envelope.nonce, "base64"));
    decipher.setAAD(aad(environment));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return parseSecretDocument(plaintext);
  } catch (error) {
    if (error instanceof SecretsError) throw error;
    throw new SecretsError("Unable to decrypt credentials: the key, environment, or ciphertext is invalid");
  }
}

async function atomicWrite(filePath: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, filePath);
    await chmod(filePath, mode);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function resolveMasterKey(root: string, environment: EnvironmentName, environmentKey?: string): Promise<string> {
  if (environmentKey) return parseKey(environmentKey).toString("hex");
  const paths = credentialsPaths(root, environment);
  try {
    return parseKey(await readFile(paths.key, "utf8")).toString("hex");
  } catch (error) {
    if (error instanceof SecretsError) throw error;
    throw new SecretsError(`Master key not found: ${paths.key}; set TRESTLE_MASTER_KEY or run trestle secrets init`);
  }
}

export async function initializeSecrets(root: string, environment: EnvironmentName): Promise<{ keyPath: string; encryptedPath: string }> {
  const paths = credentialsPaths(root, environment);
  for (const filePath of [paths.key, paths.encrypted]) {
    try {
      await stat(filePath);
      throw new SecretsError(`Refusing to overwrite existing file: ${filePath}`);
    } catch (error) {
      if (error instanceof SecretsError) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const key = randomBytes(32).toString("hex");
  await atomicWrite(paths.key, `${key}\n`);
  await atomicWrite(paths.encrypted, encryptSecrets({}, environment, key));
  return { keyPath: paths.key, encryptedPath: paths.encrypted };
}

export async function readSecrets(root: string, environment: EnvironmentName, environmentKey?: string): Promise<SecretValues> {
  const paths = credentialsPaths(root, environment);
  const [encrypted, key] = await Promise.all([
    readFile(paths.encrypted, "utf8").catch(() => { throw new SecretsError(`Encrypted credentials not found: ${paths.encrypted}`); }),
    resolveMasterKey(root, environment, environmentKey),
  ]);
  return decryptSecrets(encrypted, environment, key);
}

export async function writeSecrets(root: string, environment: EnvironmentName, values: SecretValues, environmentKey?: string): Promise<void> {
  const key = await resolveMasterKey(root, environment, environmentKey);
  await atomicWrite(credentialsPaths(root, environment).encrypted, encryptSecrets(values, environment, key));
}

export function validateSecrets(values: SecretValues, manifest: ProjectManifest, environment: EnvironmentName): string[] {
  const declarations = manifest.secrets ?? {};
  const problems: string[] = [];
  for (const name of Object.keys(values)) {
    if (!declarations[name]) problems.push(`${name} is not declared in .trestle/project.yaml`);
  }
  for (const [name, declaration] of Object.entries(declarations)) {
    if (declaration.required.includes(environment) && !values[name]) problems.push(`${name} is required for ${environment}`);
  }
  return problems;
}

export async function editSecrets(root: string, environment: EnvironmentName, environmentKey?: string, manifest?: ProjectManifest): Promise<void> {
  const values = await readSecrets(root, environment, environmentKey);
  const directory = await mkdtemp(path.join(os.tmpdir(), "trestle-secrets-"));
  const plaintext = path.join(directory, "credentials.yml");
  try {
    await writeFile(plaintext, formatSecretDocument(values), { mode: 0o600 });
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    const [command, ...arguments_] = editor.trim().split(/\s+/u);
    if (!command) throw new SecretsError("Editor command is empty");
    while (true) {
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(command, [...arguments_, plaintext], { stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      });
      if (exitCode !== 0) throw new SecretsError(`Editor exited with status ${exitCode}`);
      try {
        const updated = parseSecretDocument(await readFile(plaintext, "utf8"));
        const problems = manifest ? validateSecrets(updated, manifest, environment) : [];
        if (problems.length > 0) throw new SecretsError(`Credentials are invalid:\n${problems.join("\n")}`);
        await writeSecrets(root, environment, updated, environmentKey);
        break;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\nReopening ${editor} without overwriting encrypted credentials.\n`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function rotateMasterKey(root: string, environment: EnvironmentName, environmentKey?: string): Promise<string> {
  const values = await readSecrets(root, environment, environmentKey);
  const key = randomBytes(32).toString("hex");
  const paths = credentialsPaths(root, environment);
  await atomicWrite(paths.encrypted, encryptSecrets(values, environment, key));
  await atomicWrite(paths.key, `${key}\n`);
  return paths.key;
}
