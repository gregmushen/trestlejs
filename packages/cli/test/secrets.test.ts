import { describe, expect, it } from "vitest";

import { parseProjectManifest } from "@trestlejs/core";

import { adminSecretValues, decryptSecrets, encryptSecrets, validateSecrets } from "../src/secrets.js";

const key = "11".repeat(32);

describe("encrypted credentials envelope", () => {
  it("round-trips values and uses a fresh nonce", () => {
    const values = { API_KEY: "visible only after decryption" };
    const first = encryptSecrets(values, "local", key);
    const second = encryptSecrets(values, "local", key);
    expect(first).not.toBe(second);
    expect(decryptSecrets(first, "local", key)).toEqual(values);
  });

  it("binds ciphertext to its logical environment", () => {
    const encrypted = encryptSecrets({ API_KEY: "secret" }, "staging", key);
    expect(() => decryptSecrets(encrypted, "production", key)).toThrow("belong to staging");
  });

  it("fails closed when ciphertext is modified", () => {
    const envelope = JSON.parse(encryptSecrets({ API_KEY: "secret" }, "local", key)) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    expect(() => decryptSecrets(JSON.stringify(envelope), "local", key)).toThrow("Unable to decrypt");
  });
});

function manifestWith(admin: boolean, secrets: string) {
  return parseProjectManifest(`schemaVersion: 1
project:
  name: fixture
apps:
  worker: apps/worker
${admin ? "  admin: apps/admin\n" : ""}packages: {}
tenancy:
  model: organization
  enforcement: postgres-rls
database:
  engine: postgresql
  defaultProvider: neon
capabilities:
  r2: false
  queues: false
  workflows: false
  durableObjects: false
  admin: ${admin}
environments: [local, staging]
secrets:
${secrets}`);
}

const adminSecrets = `  DATABASE_URL:
    target: worker
    shareWith: [admin]
    required: [staging]
  STRIPE_SECRET_KEY:
    target: worker
    required: [staging]
  DATABASE_ADMIN_URL:
    target: admin
    required: [staging]
`;

describe("platform admin secrets", () => {
  const workerValues = { DATABASE_URL: "postgres://app", STRIPE_SECRET_KEY: "sk_test" };

  it("requires admin-only secrets only when the admin capability is enabled", () => {
    expect(validateSecrets(workerValues, manifestWith(false, adminSecrets), "staging")).toEqual([]);
    expect(validateSecrets(workerValues, manifestWith(true, adminSecrets), "staging")).toEqual(["DATABASE_ADMIN_URL is required for staging"]);
  });

  it("gives the admin Worker only admin-targeted and explicitly shared values", () => {
    expect(adminSecretValues({ ...workerValues, DATABASE_ADMIN_URL: "postgres://platform" }, manifestWith(true, adminSecrets))).toEqual({ DATABASE_URL: "postgres://app", DATABASE_ADMIN_URL: "postgres://platform" });
  });

  it("shares only Worker secrets, and only with the admin Worker", () => {
    expect(() => manifestWith(false, "  STRIPE_SECRET_KEY:\n    target: worker\n    shareWith: [ci]\n    required: [local]\n")).toThrow();
    expect(() => manifestWith(false, "  CI_TOKEN:\n    target: ci\n    shareWith: [admin]\n    required: [local]\n")).toThrow();
  });
});
