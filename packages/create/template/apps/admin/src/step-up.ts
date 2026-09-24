/**
 * Step-up rules the admin UI shares between sensitive actions (admin API 428s)
 * and factor management (Better Auth 428s from the admin Worker). The server
 * decides the required level; these helpers only read its answer.
 */
export type AssuranceLevel = "password" | "mfa" | "phishing_resistant";

const levels: readonly AssuranceLevel[] = ["password", "mfa", "phishing_resistant"];

/** The level a 428 names. An unknown or missing level asks for the strongest, so a UI never offers a weaker path than the server wants. */
export function assuranceLevelOf(value: unknown): AssuranceLevel {
  return levels.includes(value as AssuranceLevel) ? value as AssuranceLevel : "phishing_resistant";
}

/** Shown whenever a request could not reach the admin Worker at all. */
export const networkErrorMessage = "Could not reach the server. Try again.";

/** Better Auth client errors carry the Worker's JSON body plus the HTTP status. */
type AuthError = { status?: number; error?: string; reason?: string; message?: string; required?: string } | null | undefined;

/** The level a Better Auth error asks for when it is a step-up challenge, otherwise null. */
export function stepUpRequirement(error: unknown): AssuranceLevel | null {
  const value = error as AuthError;
  if (!value || typeof value !== "object" || (value.status !== 428 && value.error !== "step_up_required")) return null;
  return assuranceLevelOf(value.required);
}

/**
 * Which re-authentication paths can reach `required`. A passkey satisfies every
 * level, so it is always offered; only a passkey reaches phishing-resistant. The
 * password path continues with a code when the account has TOTP. An account with
 * a passkey but no TOTP is not offered a password: that sign-in would prove only
 * a password and fall below the admin's minimum sign-in level.
 */
export function stepUpMethods(required: AssuranceLevel, factors?: Readonly<{ totp: boolean; passkeys: number }>): Readonly<{ password: boolean; passkey: boolean }> {
  const passwordFallsBelowSignIn = factors !== undefined && factors.passkeys > 0 && !factors.totp;
  return { password: required !== "phishing_resistant" && !passwordFallsBelowSignIn, passkey: true };
}

/** A readable message for a failed factor call, including the Worker's operator-only refusals. */
export function authErrorMessage(error: unknown, fallback: string): string {
  const value = error as AuthError;
  if (value?.reason === "no_platform_roles") return "This account has no platform role, so it cannot manage platform admin sign-in factors. Sign in as a platform operator.";
  if (value?.reason === "local_account") return "The default local admin account only works in local development. Sign in with your own operator account.";
  return value?.message || fallback;
}

export type StepUpIdentity = Readonly<{
  currentUserId: () => Promise<string | null>;
  /** Resolves when the session is gone; rejects when it could not be signed out. */
  signOut: () => Promise<void>;
}>;

/**
 * Confirms a step-up signed in the operator who started it. A passkey is
 * discoverable, so it can sign in a different account; that session is signed
 * out and the action is never retried as that account. When the account cannot
 * be confirmed at all, the session is signed out too (fail closed).
 */
export async function confirmStepUpIdentity(operatorId: string, method: "passkey" | "password", identity: StepUpIdentity): Promise<{ ok: true } | { ok: false; error: string; signedOut: boolean }> {
  let current: string | null;
  let lookupFailed = false;
  try { current = await identity.currentUserId(); } catch { current = null; lookupFailed = true; }
  if (current === operatorId) return { ok: true };
  try { await identity.signOut(); } catch { return { ok: false, error: "Could not sign that account out; close this browser tab.", signedOut: false }; }
  if (lookupFailed) return { ok: false, error: "Could not confirm which account signed in, so you have been signed out. Sign in again.", signedOut: true };
  return { ok: false, signedOut: true, error: `That ${method === "passkey" ? "passkey" : "sign-in"} belongs to a different account, so you have been signed out. Sign in again as yourself.` };
}
