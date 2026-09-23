import { describe, expect, it } from "vitest";

import { createSignedWebhookHeaders, decodeWebhookSigningSecret } from "./webhook-signing.js";

const raw = "shared-webhook-signing-key-material-123456";
const secret = `whsec_${btoa(raw)}`;

describe("shared local and native webhook signing", () => {
  it("signs the exact message identity, timestamp, and body", async () => {
    const body = '{"title":"café"}';
    const headers = await createSignedWebhookHeaders({ secret, messageId: "whm_abc123", body, now: new Date("2026-09-23T12:00:00.500Z") });
    expect(headers).toMatchObject({ "content-type": "application/json", "webhook-id": "whm_abc123", "webhook-timestamp": "1790164800" });
    const key = await crypto.subtle.importKey("raw", decodeWebhookSigningSecret(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(atob(headers["webhook-signature"].slice(3)), (character) => character.charCodeAt(0));
    expect(await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(`whm_abc123.1790164800.${body}`))).toBe(true);
    expect(await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(`whm_abc123.1790164800.${body} `))).toBe(false);
  });

  it("rejects malformed secrets, identities, and clocks", async () => {
    expect(() => decodeWebhookSigningSecret("short")).toThrow("signing secret");
    expect(() => decodeWebhookSigningSecret("whsec_invalid")).toThrow("signing secret");
    await expect(createSignedWebhookHeaders({ secret, messageId: "bad\nheader", body: "{}", now: new Date() })).rejects.toThrow("signing input");
    await expect(createSignedWebhookHeaders({ secret, messageId: "whm_abc123", body: "{}", now: new Date("invalid") })).rejects.toThrow("clock");
  });
});
