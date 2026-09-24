import { describe, expect, it } from "vitest";

import { apiKeyStatus, bearerApiKey, mintApiKey, parseApiKey, rotationExpiry, validateApiKeyScopes, verifyApiKey } from "./api-keys.js";
import { permissions } from "./permissions.js";

describe("scoped API keys", () => {
  it("mints environment-prefixed tokens that verify only against their own verifier", async () => {
    const live = await mintApiKey("production");
    const dev = await mintApiKey("local");
    expect(live.token).toMatch(/^tr_live_[A-Za-z0-9]{16}_[A-Za-z0-9_-]{43}$/u);
    expect(live.displayPrefix).toBe(`tr_live_${live.publicId}`);
    expect(dev.token.startsWith("tr_dev_")).toBe(true);
    expect(live.verifier).toMatch(/^[a-f0-9]{64}$/u);
    expect(live.verifier).not.toContain(live.token.slice(-43));
    expect(parseApiKey(live.token)).toEqual({ environmentPrefix: "live", publicId: live.publicId });
    expect(parseApiKey("tr_live_short_secret")).toBeNull();
    expect(await verifyApiKey(live.token, live.verifier)).toBe(true);
    expect(await verifyApiKey(dev.token, live.verifier)).toBe(false);
    expect(bearerApiKey(`Bearer ${live.token}`)).toBe(live.token);
    expect(bearerApiKey("Bearer eyJhbGciOi")).toBeNull();
  });

  it("reports the most durable reason a key cannot act", () => {
    const now = new Date("2026-09-23T12:00:00Z");
    const active = { environment: "production", expiresAt: null, revokedAt: null, serviceAccountStatus: "active" };
    expect(apiKeyStatus(active, { now, environment: "production" })).toBe("active");
    expect(apiKeyStatus({ ...active, revokedAt: now, expiresAt: now }, { now, environment: "production" })).toBe("revoked");
    expect(apiKeyStatus({ ...active, expiresAt: now }, { now, environment: "production" })).toBe("expired");
    expect(apiKeyStatus(active, { now, environment: "staging" })).toBe("wrong_environment");
    expect(apiKeyStatus({ ...active, serviceAccountStatus: "suspended" }, { now, environment: "production" })).toBe("service_account_suspended");
  });

  it("bounds rotation overlap and never extends a key", () => {
    const now = new Date("2026-09-23T12:00:00Z");
    expect(rotationExpiry(now, 24).toISOString()).toBe("2026-09-24T12:00:00.000Z");
    expect(rotationExpiry(now, 24, new Date("2026-09-23T13:00:00Z")).toISOString()).toBe("2026-09-23T13:00:00.000Z");
    expect(() => rotationExpiry(now, 169)).toThrow("between 0 and 168");
  });

  it("scopes keys to application permissions that admit API keys", () => {
    expect(validateApiKeyScopes(permissions, ["resource.read", "resource.write"])).toEqual([]);
    expect(validateApiKeyScopes(permissions, [])).toEqual(["An API key needs at least one scope"]);
    expect(validateApiKeyScopes(permissions, ["organization.read"])[0]).toContain("application permissions only");
    expect(validateApiKeyScopes(permissions, ["platform.overview.read"])[0]).toContain("application permissions only");
    expect(validateApiKeyScopes(permissions, ["application.roles.assign"])[0]).toContain("not available to API keys");
    expect(validateApiKeyScopes(permissions, ["nope.read"])[0]).toContain("not a registered permission");
  });
});
