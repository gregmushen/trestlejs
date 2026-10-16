import { describe, expect, it } from "vitest";

import { findCredentialLeaves, looksLikeCredential, redact, safeInfraDiagnostic, sanitizedInfraValue } from "../src/infra/redaction.js";

describe("infrastructure redaction", () => {
  it("recognizes credentials by content rather than key name", () => {
    for (const value of ["rkcs_test_51ULdABCDEFGHIJKLMNOPQRSTUVWX", "xyz_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ12", "sk_live_ABCDEFGH12345678", "rk_test_ABCDEFGH12345678", "whsec_abcdefgh1234", "re_ABCDEFGHIJKLMNOPQRS", "napi_abcdefghijklmnop1234", "postgres://owner:pw@ep-cool.neon.tech/db", "https://user:token@example.com", "-----BEGIN RSA PRIVATE KEY-----"]) expect(looksLikeCredential(value), value).toBe(true);
    for (const value of ["postgres://ep-cool.neon.tech/db", "neon/postgres", "DATABASE_URL", "acct_1234567890", "prvsvc_61UWwfdl8fjbyyOqy52ZM"]) expect(looksLikeCredential(value), value).toBe(false);
  });

  it("finds nested credential leaves, including keys and arrays", () => {
    expect(findCredentialLeaves({ a: { b: ["fine", "sk_live_ABCDEFGH12345678"] }, ok: "x" })).toEqual(["$.a.b[1]"]);
    expect(findCredentialLeaves({ "postgres://u:p@h/db": 1 })).toEqual(["$.<key>"]);
  });

  it("redacts every occurrence and known secret values", () => {
    const text = "error: sk_live_ABCDEFGH12345678 and again sk_live_ABCDEFGH12345678; custom=opaque-value-1234";
    const result = redact(text, ["opaque-value-1234"]);
    expect(result).not.toMatch(/sk_live_|opaque-value-1234/u);
    expect(result.match(/\[redacted\]/gu)).toHaveLength(3);
  });

  it("withholds opaque authorization and named secrets while preserving nonsecret fencing metadata", () => {
    const opaque = "cfsyntheticopaquetoken01234567890123456789";
    for (const text of [`Authorization: Bearer ${opaque}`, `Basic ${opaque}`, `CLOUDFLARE_API_TOKEN=${opaque}`, 'password="synthetic-password-value"', `X-API-Key: ${opaque}`, `Cookie: session=${opaque}; other=private-cookie`]) {
      expect(safeInfraDiagnostic(text)).not.toMatch(/cfsynthetic|synthetic-password-value|private-cookie/);
    }
    const result = sanitizedInfraValue({ CLOUDFLARE_API_TOKEN: opaque, password: "synthetic-password-value", accessToken: opaque, nested: [{ privateKeyPem: "synthetic-private-key", note: `Bearer ${opaque}`, unusual: "sk_live_ACCIDENTAL123456789" }], fencingToken: 17, publicKeyPem: "public-nonsecret", operationId: "op-example" });
    expect(JSON.stringify(result)).not.toMatch(/cfsynthetic|synthetic-password-value|synthetic-private-key|sk_live_/);
    expect(result).toMatchObject({ fencingToken: 17, publicKeyPem: "public-nonsecret", operationId: "op-example" });
  });
});
