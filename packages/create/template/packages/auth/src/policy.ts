import { applicationConnectionString, createSqlRunner, type DatabaseDriver } from "@__TRESTLE_PROJECT_NAME__/db";
import { sql } from "drizzle-orm";

/**
 * Runtime authentication policy (docs/ADMIN_REQUIRED_CHANGES.md §10). Better
 * Auth remains the engine; these are the safe settings an operator may change
 * without a deploy. Providers, secrets, origins, callbacks, cookies, and
 * plugin installation stay setup-owned and never appear here.
 */
export type AuthPolicy = Readonly<{
  signIn: Readonly<{ password: boolean }>;
  registration: Readonly<{ mode: "open" | "invite_only" | "closed"; requireEmailVerification: boolean }>;
  password: Readonly<{ minLength: number; resetEnabled: boolean; revokeSessionsOnReset: boolean }>;
  mfa: Readonly<{ trustedDeviceDays: number }>;
  /** Freshness window for sensitive operator actions (step-up). */
  stepUp: Readonly<{ windowMinutes: number }>;
  sessions: Readonly<{ lifetimeDays: number; refreshHours: number; maxConcurrent: number }>;
  organizations: Readonly<{ allowCreation: boolean; limitPerUser: number; invitationExpiryDays: number; membershipLimit: number }>;
}>;

/** Better Auth's defaults, plus Trestle's step-up window: what applies when no runtime version is active. */
export const defaultAuthPolicy: AuthPolicy = {
  signIn: { password: true },
  registration: { mode: "open", requireEmailVerification: true },
  password: { minLength: 8, resetEnabled: true, revokeSessionsOnReset: false },
  mfa: { trustedDeviceDays: 30 },
  stepUp: { windowMinutes: 15 },
  sessions: { lifetimeDays: 7, refreshHours: 24, maxConcurrent: 0 },
  organizations: { allowCreation: true, limitPerUser: 0, invitationExpiryDays: 2, membershipLimit: 100 },
};

const ranges: ReadonlyArray<readonly [path: string, min: number, max: number]> = [
  ["password.minLength", 8, 128], ["mfa.trustedDeviceDays", 1, 90], ["stepUp.windowMinutes", 5, 60],
  ["sessions.lifetimeDays", 1, 90], ["sessions.refreshHours", 1, 168], ["sessions.maxConcurrent", 0, 100],
  ["organizations.limitPerUser", 0, 1000], ["organizations.invitationExpiryDays", 1, 30], ["organizations.membershipLimit", 1, 100_000],
];

const at = (policy: AuthPolicy, path: string): unknown => path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], policy);

/** Shape and range problems; the policy is otherwise well formed. */
export function authPolicyShapeProblems(policy: AuthPolicy): string[] {
  const problems: string[] = [];
  for (const [path, min, max] of ranges) {
    const value = at(policy, path);
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) problems.push(`${path} must be a whole number from ${min} to ${max}`);
  }
  if (policy.sessions.refreshHours >= policy.sessions.lifetimeDays * 24) problems.push("Sessions must refresh more often than they expire");
  return problems;
}

/** What the safeguards need to know about the deployment and the platform administrators who must keep access. */
export type AuthPolicyFacts = Readonly<{
  environment: string;
  capabilities: Readonly<{ passkeys: boolean; twoFactor: boolean; sso: string }>;
  /** Whether verification, reset, and invitation email can be delivered right now. */
  emailHealthy: boolean;
  platformAdmins: ReadonlyArray<Readonly<{ userId: string; passkeys: number; twoFactor: boolean }>>;
}>;

/**
 * Safeguards: refuse a policy that would remove the last viable platform-admin
 * sign-in or recovery path, require an unavailable factor or provider, or
 * depend on an unhealthy verification or recovery delivery route.
 */
export function authPolicySafeguardProblems(policy: AuthPolicy, facts: AuthPolicyFacts): string[] {
  const problems: string[] = [];
  const admins = facts.platformAdmins;
  if (admins.length === 0) problems.push("There is no active platform administrator; assign one before changing authentication policy");
  if (!policy.signIn.password) {
    if (!admins.some((admin) => admin.passkeys > 0)) problems.push("Disabling password sign-in would remove the last viable platform-admin sign-in path: no platform administrator has a passkey");
    if (!facts.capabilities.passkeys && facts.capabilities.sso === "disabled") problems.push("Disabling password sign-in requires passkeys or SSO, and neither is installed (trestle setup)");
  }
  if (!policy.password.resetEnabled && !admins.some((admin) => admin.twoFactor || admin.passkeys > 0)) {
    problems.push("Disabling password reset would remove the last platform-admin recovery path: no platform administrator has two-factor backup codes or a passkey");
  }
  if (policy.mfa.trustedDeviceDays !== defaultAuthPolicy.mfa.trustedDeviceDays && !facts.capabilities.twoFactor) problems.push("Trusted devices require two-factor authentication, which is not installed (trestle setup)");
  if (!facts.emailHealthy) {
    const dependent = [
      ...(policy.registration.requireEmailVerification && policy.registration.mode !== "closed" ? ["email verification"] : []),
      ...(policy.password.resetEnabled ? ["password reset"] : []),
      ...(policy.registration.mode === "invite_only" ? ["invitations"] : []),
    ];
    if (dependent.length) problems.push(`Email delivery is unhealthy, so ${dependent.join(", ")} cannot be relied on; repair email or turn these off`);
  }
  return problems;
}

/** Plain statements of what activating `next` changes relative to `current`. */
export function authPolicyImpact(current: AuthPolicy, next: AuthPolicy): string[] {
  const lines: string[] = [];
  const changed = (path: string) => at(current, path) !== at(next, path);
  if (changed("signIn.password")) lines.push(next.signIn.password ? "Password sign-in is allowed again" : "Password sign-in is refused; members use passkeys or SSO");
  if (changed("registration.mode")) lines.push({ open: "Anyone can sign up", invite_only: "Sign-up requires a pending invitation for the email address", closed: "New sign-ups are refused" }[next.registration.mode]);
  if (changed("registration.requireEmailVerification")) lines.push(next.registration.requireEmailVerification ? "New accounts must verify their email before signing in" : "New accounts can sign in without verifying their email");
  if (changed("password.minLength")) lines.push(`New passwords need at least ${next.password.minLength} characters; existing passwords keep working`);
  if (changed("password.resetEnabled")) lines.push(next.password.resetEnabled ? "Password reset by email is available" : "Password reset by email is refused");
  if (changed("password.revokeSessionsOnReset")) lines.push(next.password.revokeSessionsOnReset ? "A password reset signs out every other session" : "A password reset keeps other sessions");
  if (changed("mfa.trustedDeviceDays")) lines.push(`Trusted devices skip the second factor for ${next.mfa.trustedDeviceDays} days`);
  if (changed("stepUp.windowMinutes")) lines.push(`Sensitive operator actions need sign-in evidence from the last ${next.stepUp.windowMinutes} minutes`);
  if (changed("sessions.lifetimeDays")) lines.push(`Sessions expire after ${next.sessions.lifetimeDays} days without refresh${next.sessions.lifetimeDays < current.sessions.lifetimeDays ? "; longer existing sessions end at their next refresh" : ""}`);
  if (changed("sessions.refreshHours")) lines.push(`Active sessions refresh every ${next.sessions.refreshHours} hours`);
  if (changed("sessions.maxConcurrent")) lines.push(next.sessions.maxConcurrent ? `Each account keeps at most ${next.sessions.maxConcurrent} sessions; the oldest is revoked at the next sign-in` : "Concurrent sessions are unlimited");
  if (changed("organizations.allowCreation")) lines.push(next.organizations.allowCreation ? "Members can create organizations" : "Members cannot create organizations");
  if (changed("organizations.limitPerUser")) lines.push(next.organizations.limitPerUser ? `Each member can create up to ${next.organizations.limitPerUser} organizations` : "No per-member organization limit");
  if (changed("organizations.invitationExpiryDays")) lines.push(`New invitations expire after ${next.organizations.invitationExpiryDays} days`);
  if (changed("organizations.membershipLimit")) lines.push(`Organizations accept up to ${next.organizations.membershipLimit} members`);
  return lines;
}

/** Merges a stored policy over the defaults so older versions stay valid as settings are added. */
export function normalizeAuthPolicy(stored: unknown): AuthPolicy {
  const value = (stored ?? {}) as Partial<Record<keyof AuthPolicy, Record<string, unknown>>>;
  return Object.fromEntries(Object.entries(defaultAuthPolicy).map(([section, defaults]) => [section, { ...defaults, ...(value[section as keyof AuthPolicy] ?? {}) }])) as AuthPolicy;
}

type CacheEntry = { policy: AuthPolicy; version: number | null; loadedAt: number };
const cache = new Map<string, CacheEntry>();
/** Activation reaches every isolate within this window. */
export const authPolicyCacheMilliseconds = 10_000;

/** The active runtime policy (or the defaults), cached per isolate; call once per request before createAuth. */
export async function loadAuthPolicy(environment: Readonly<{ DATABASE_URL: string; DATABASE_DRIVER?: DatabaseDriver }>, now = Date.now()): Promise<CacheEntry> {
  const hit = cache.get(environment.DATABASE_URL);
  if (hit && now - hit.loadedAt < authPolicyCacheMilliseconds) return hit;
  try {
    const [row] = await createSqlRunner(applicationConnectionString(environment.DATABASE_URL), environment.DATABASE_DRIVER).query(sql`select version, policy from auth_policy_version where state = 'active' limit 1`);
    const entry = { policy: row ? normalizeAuthPolicy(typeof row.policy === "string" ? JSON.parse(row.policy) : row.policy) : defaultAuthPolicy, version: row ? Number(row.version) : null, loadedAt: now };
    cache.set(environment.DATABASE_URL, entry);
    return entry;
  } catch {
    // Keep serving the last known policy if the lookup fails; fail to defaults only when nothing is known.
    return hit ?? { policy: defaultAuthPolicy, version: null, loadedAt: now };
  }
}

/** The last loaded policy for this database, or the defaults. */
export function cachedAuthPolicy(environment: Readonly<{ DATABASE_URL: string }>): AuthPolicy {
  return cache.get(environment.DATABASE_URL)?.policy ?? defaultAuthPolicy;
}

/** Drops the cached policy (after activation in this isolate). */
export function forgetAuthPolicy(environment: Readonly<{ DATABASE_URL: string }>): void {
  cache.delete(environment.DATABASE_URL);
}
