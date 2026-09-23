import { describe, expect, it } from "vitest";

import { createWebhookSecretCipher, WebhookSecretService } from "./webhook-secrets.js";

describe("webhook secret encryption boundary", () => {
  const key = "test-webhook-master-key-with-sufficient-length-123";
  const secret = "whsec_dGVzdC1zZWNyZXQta2V5LW1hdGVyaWFs";

  it("encrypts with random IVs and authenticates tenant, endpoint, version, and environment", async () => {
    const cipher = await createWebhookSecretCipher(key, "local");
    const first = await cipher.encrypt(secret, "organization-a", "endpoint-a", 1);
    const second = await cipher.encrypt(secret, "organization-a", "endpoint-a", 1);
    expect(first).toMatch(/^v1:/u);
    expect(first).not.toBe(second);
    expect(first).not.toContain(secret);
    expect(await cipher.decrypt(first, "organization-a", "endpoint-a", 1)).toBe(secret);
    await expect(cipher.decrypt(first, "organization-b", "endpoint-a", 1)).rejects.toThrow("could not be decrypted");
    await expect(cipher.decrypt(first, "organization-a", "endpoint-b", 1)).rejects.toThrow("could not be decrypted");
    await expect(cipher.decrypt(first, "organization-a", "endpoint-a", 2)).rejects.toThrow("could not be decrypted");
    const staging = await createWebhookSecretCipher(key, "staging");
    await expect(staging.decrypt(first, "organization-a", "endpoint-a", 1)).rejects.toThrow("could not be decrypted");
  });

  it("rejects weak keys and damaged ciphertext without disclosing material", async () => {
    await expect(createWebhookSecretCipher("too-short", "local")).rejects.toThrow("WEBHOOK_SECRET_KEY");
    expect(() => new WebhookSecretService({ tenantDatabase: () => { throw new Error("not reached"); }, authority: { authorize: async () => ({ actorId: "test" }) }, masterKey: "too-short", environment: "local", clock: { now: () => new Date() } })).toThrow("WEBHOOK_SECRET_KEY");
    const cipher = await createWebhookSecretCipher(key, "local");
    await expect(cipher.decrypt("v2:abc:def", "org", "endpoint", 1)).rejects.toThrow("Unsupported");
    await expect(cipher.decrypt("v1:abc:def", "org", "endpoint", 1)).rejects.toThrow("could not be decrypted");
  });
});
