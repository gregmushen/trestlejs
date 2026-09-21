import { describe, expect, it } from "vitest";

import { decryptSecrets, encryptSecrets } from "../src/secrets.js";

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
