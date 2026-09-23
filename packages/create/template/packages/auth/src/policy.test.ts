import { describe, expect, it } from "vitest";

import { authPolicyImpact, authPolicySafeguardProblems, authPolicyShapeProblems, defaultAuthPolicy, normalizeAuthPolicy, type AuthPolicy, type AuthPolicyFacts } from "./policy.js";

const facts = (overrides: Partial<AuthPolicyFacts> = {}): AuthPolicyFacts => ({
  environment: "production", capabilities: { passkeys: true, twoFactor: true, sso: "disabled" }, emailHealthy: true,
  platformAdmins: [{ userId: "admin-1", passkeys: 1, twoFactor: true }], ...overrides,
});
const withChange = (change: (policy: AuthPolicy) => AuthPolicy) => change(defaultAuthPolicy);

describe("authentication policy safeguards", () => {
  it("accepts the defaults with a guardian who can sign in and recover", () => {
    expect(authPolicyShapeProblems(defaultAuthPolicy)).toEqual([]);
    expect(authPolicySafeguardProblems(defaultAuthPolicy, facts())).toEqual([]);
  });

  it("refuses removing the last platform-admin sign-in path", () => {
    const passwordless = withChange((policy) => ({ ...policy, signIn: { password: false } }));
    expect(authPolicySafeguardProblems(passwordless, facts())).toEqual([]);
    expect(authPolicySafeguardProblems(passwordless, facts({ platformAdmins: [{ userId: "admin-1", passkeys: 0, twoFactor: true }] }))).toEqual([expect.stringMatching(/last viable platform-admin sign-in path/u)]);
    expect(authPolicySafeguardProblems(passwordless, facts({ capabilities: { passkeys: false, twoFactor: true, sso: "disabled" } }))).toEqual([expect.stringMatching(/requires passkeys or SSO/u)]);
    expect(authPolicySafeguardProblems(defaultAuthPolicy, facts({ platformAdmins: [] }))).toEqual([expect.stringMatching(/no active platform administrator/u)]);
  });

  it("refuses removing the last recovery path and unavailable factors", () => {
    const noReset = withChange((policy) => ({ ...policy, password: { ...policy.password, resetEnabled: false } }));
    expect(authPolicySafeguardProblems(noReset, facts({ platformAdmins: [{ userId: "a", passkeys: 0, twoFactor: false }] }))).toEqual([expect.stringMatching(/last platform-admin recovery path/u)]);
    const trusted = withChange((policy) => ({ ...policy, mfa: { trustedDeviceDays: 7 } }));
    expect(authPolicySafeguardProblems(trusted, facts({ capabilities: { passkeys: true, twoFactor: false, sso: "disabled" } }))).toEqual([expect.stringMatching(/two-factor authentication, which is not installed/u)]);
  });

  it("refuses depending on an unhealthy email route", () => {
    expect(authPolicySafeguardProblems(defaultAuthPolicy, facts({ emailHealthy: false }))).toEqual([expect.stringMatching(/email verification, password reset cannot be relied on/u)]);
    const independent = withChange((policy) => ({ ...policy, registration: { mode: "closed", requireEmailVerification: true }, password: { ...policy.password, resetEnabled: false } }));
    expect(authPolicySafeguardProblems(independent, facts({ emailHealthy: false }))).toEqual([]);
  });

  it("validates ranges and describes the impact of a change", () => {
    const broken = withChange((policy) => ({ ...policy, sessions: { lifetimeDays: 1, refreshHours: 48, maxConcurrent: -1 } }));
    expect(authPolicyShapeProblems(broken)).toEqual(["sessions.maxConcurrent must be a whole number from 0 to 100", "Sessions must refresh more often than they expire"]);
    const next = withChange((policy) => ({ ...policy, registration: { ...policy.registration, mode: "invite_only" }, sessions: { ...policy.sessions, lifetimeDays: 1, maxConcurrent: 2 } }));
    expect(authPolicyImpact(defaultAuthPolicy, next)).toEqual([
      "Sign-up requires a pending invitation for the email address",
      "Sessions expire after 1 days without refresh; longer existing sessions end at their next refresh",
      "Each account keeps at most 2 sessions; the oldest is revoked at the next sign-in",
    ]);
  });

  it("fills settings added after a version was stored from the defaults", () => {
    expect(normalizeAuthPolicy({ sessions: { lifetimeDays: 3 } }).sessions).toEqual({ ...defaultAuthPolicy.sessions, lifetimeDays: 3 });
    expect(normalizeAuthPolicy(null)).toEqual(defaultAuthPolicy);
  });
});
