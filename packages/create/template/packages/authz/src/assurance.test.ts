import { describe, expect, it } from "vitest";

import { assuranceForEndpoint, meetsRequirement, platformAssuranceRequirement, securityEventForEndpoint } from "./assurance.js";

const now = new Date("2026-09-23T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("authentication assurance", () => {
  it("derives what a new session proves from the endpoint that created it", () => {
    expect(assuranceForEndpoint("/sign-in/email")).toEqual({ level: "password", method: "password" });
    expect(assuranceForEndpoint("/two-factor/verify-totp")).toEqual({ level: "mfa", method: "totp" });
    expect(assuranceForEndpoint("/two-factor/verify-backup-code")).toEqual({ level: "mfa", method: "backup_code" });
    expect(assuranceForEndpoint("/passkey/verify-authentication")).toEqual({ level: "phishing_resistant", method: "passkey" });
  });

  it("requires the level and freshness, and says why it fails", () => {
    const requirement = { level: "mfa" as const, maxAgeMinutes: 15 };
    expect(meetsRequirement(null, requirement, now)).toEqual({ ok: false, reason: "missing" });
    expect(meetsRequirement({ sessionId: "s", level: "password", method: "password", verifiedAt: minutesAgo(1) }, requirement, now)).toEqual({ ok: false, reason: "insufficient_level" });
    expect(meetsRequirement({ sessionId: "s", level: "mfa", method: "totp", verifiedAt: minutesAgo(16) }, requirement, now)).toEqual({ ok: false, reason: "stale" });
    expect(meetsRequirement({ sessionId: "s", level: "phishing_resistant", method: "passkey", verifiedAt: minutesAgo(1) }, requirement, now)).toEqual({ ok: true });
  });

  it("accepts a fresh password locally and requires factors when deployed", () => {
    expect(platformAssuranceRequirement("platform.outbox.redrive", "local")).toEqual({ level: "password", maxAgeMinutes: 15 });
    expect(platformAssuranceRequirement("platform.outbox.redrive", "production")).toEqual({ level: "mfa", maxAgeMinutes: 15 });
    expect(platformAssuranceRequirement("platform.roles.manage", "staging")).toEqual({ level: "phishing_resistant", maxAgeMinutes: 15 });
  });

  it("names audited account-security changes without credential material", () => {
    expect(securityEventForEndpoint("/two-factor/disable")).toBe("security.two_factor.disabled");
    expect(securityEventForEndpoint("/passkey/verify-registration")).toBe("security.passkey.added");
    expect(securityEventForEndpoint("/sign-in/email")).toBeNull();
  });
});
