import type { ApplicationEnvironment } from "./api-keys.js";
import type { PermissionCode } from "./permissions.js";

/**
 * Authentication assurance. Better Auth owns the credential protocols;
 * Trestle records, per session, how the session was authenticated and when,
 * and sensitive actions require a level and freshness from that evidence
 * rather than from session age or from `twoFactorEnabled` on the account.
 */
export type AssuranceLevel = "password" | "mfa" | "phishing_resistant";
export type AssuranceMethod = "password" | "totp" | "otp" | "backup_code" | "passkey" | "sso";
export type AuthenticationAssurance = Readonly<{ level: AssuranceLevel; method: AssuranceMethod; verifiedAt: Date; sessionId: string }>;

export const assuranceRank: Readonly<Record<AssuranceLevel, number>> = { password: 1, mfa: 2, phishing_resistant: 3 };

/**
 * The Better Auth endpoint that created a session determines what it proves.
 * Anything not listed (for example email-link sign-in after verification) is
 * treated as single-factor password-equivalent evidence.
 */
export function assuranceForEndpoint(path: string): Readonly<{ level: AssuranceLevel; method: AssuranceMethod }> {
  switch (path) {
    case "/two-factor/verify-totp": return { level: "mfa", method: "totp" };
    case "/two-factor/verify-otp": return { level: "mfa", method: "otp" };
    case "/two-factor/verify-backup-code": return { level: "mfa", method: "backup_code" };
    case "/passkey/verify-authentication": return { level: "phishing_resistant", method: "passkey" };
    // Enterprise SSO: the identity provider's own factors are not verifiable here, so the
    // session counts as single-factor until the person steps up with a Trestle factor.
    case "/sso/callback/:providerId":
    case "/sso/callback":
    case "/sso/saml2/sp/acs/:providerId":
    case "/workos/callback": return { level: "password", method: "sso" };
    default: return { level: "password", method: "password" };
  }
}

/** Account-security changes that are audited; never with secrets, codes, or credential material. */
export function securityEventForEndpoint(path: string): string | null {
  switch (path) {
    case "/two-factor/enable": return "security.two_factor.enrollment_started";
    case "/two-factor/verify-totp": return null;
    case "/two-factor/disable": return "security.two_factor.disabled";
    case "/two-factor/generate-backup-codes": return "security.two_factor.backup_codes_regenerated";
    case "/passkey/verify-registration": return "security.passkey.added";
    case "/passkey/delete-passkey": return "security.passkey.removed";
    default: return null;
  }
}

export type AssuranceRequirement = Readonly<{ level: AssuranceLevel; maxAgeMinutes: number }>;

/** How long a verification stays fresh for step-up. */
export const stepUpWindowMinutes = 15;

export function meetsRequirement(assurance: AuthenticationAssurance | null, requirement: AssuranceRequirement, now: Date): { ok: true } | { ok: false; reason: "missing" | "insufficient_level" | "stale" } {
  if (!assurance) return { ok: false, reason: "missing" };
  if (assuranceRank[assurance.level] < assuranceRank[requirement.level]) return { ok: false, reason: "insufficient_level" };
  if (now.getTime() - assurance.verifiedAt.getTime() > requirement.maxAgeMinutes * 60_000) return { ok: false, reason: "stale" };
  return { ok: true };
}

/**
 * The least a session must prove to use the platform admin at all: once an
 * account has a second factor or a passkey, a session that proves only a
 * password (an admin password sign-in, or a session from a surface without
 * factors) is refused. Freshness does not matter here; actions check it.
 * Factorless accounts pass, so an operator can still sign in to enroll one.
 */
export function meetsSignInLevel(assurance: Pick<AuthenticationAssurance, "level"> | null, enrolled: AssuranceLevel | null): { ok: true } | { ok: false; reason: "missing" | "insufficient_level" } {
  if (!enrolled) return { ok: true };
  if (!assurance) return { ok: false, reason: "missing" };
  return assuranceRank[assurance.level] >= assuranceRank.mfa ? { ok: true } : { ok: false, reason: "insufficient_level" };
}

const phishingResistantPermissions: ReadonlySet<PermissionCode> = new Set(["platform.roles.manage"]);

/** The level ordinary platform actions require: a password locally, a second factor in every deployed environment. */
export function actionAssuranceLevel(environment: ApplicationEnvironment): AssuranceLevel {
  return environment === "local" ? "password" : "mfa";
}

/**
 * Application-owned step-up policy for sensitive platform actions. Local
 * development accepts a fresh password (the seeded admin/admin operator has no
 * second factor); every deployed environment requires MFA, and actions that
 * grant or revoke authority require phishing-resistant evidence (a passkey).
 */
export function platformAssuranceRequirement(permission: string, environment: ApplicationEnvironment): AssuranceRequirement {
  if (environment === "local") return { level: actionAssuranceLevel(environment), maxAgeMinutes: stepUpWindowMinutes };
  return { level: (phishingResistantPermissions as ReadonlySet<string>).has(permission) ? "phishing_resistant" : actionAssuranceLevel(environment), maxAgeMinutes: stepUpWindowMinutes };
}
