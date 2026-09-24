/**
 * Step-up rules the admin UI shares between sensitive actions (admin API 428s)
 * and factor management (Better Auth 428s from the admin Worker). The server
 * decides the required level; these helpers only read its answer.
 */
export type AssuranceLevel = "password" | "mfa" | "phishing_resistant";

const levels: readonly AssuranceLevel[] = ["password", "mfa", "phishing_resistant"];

/** Better Auth client errors carry the Worker's JSON body plus the HTTP status. */
type AuthError = { status?: number; error?: string; reason?: string; message?: string; required?: string } | null | undefined;

/** The level a Better Auth error asks for when it is a step-up challenge, otherwise null. */
export function stepUpRequirement(error: unknown): AssuranceLevel | null {
  const value = error as AuthError;
  if (!value || typeof value !== "object" || (value.status !== 428 && value.error !== "step_up_required")) return null;
  return levels.includes(value.required as AssuranceLevel) ? value.required as AssuranceLevel : "password";
}

/**
 * Which re-authentication paths can reach `required`. A passkey satisfies every
 * level; only a passkey reaches phishing-resistant. The password path continues
 * with a code when the account has an authenticator enrolled.
 */
export function stepUpMethods(required: AssuranceLevel): Readonly<{ password: boolean; passkey: boolean }> {
  if (required === "phishing_resistant") return { password: false, passkey: true };
  if (required === "mfa") return { password: true, passkey: true };
  return { password: true, passkey: false };
}

/** A readable message for a failed factor call, including the Worker's operator-only refusals. */
export function authErrorMessage(error: unknown, fallback: string): string {
  const value = error as AuthError;
  if (value?.reason === "no_platform_roles") return "This account has no platform role, so it cannot manage platform admin sign-in factors. Sign in as a platform operator.";
  if (value?.reason === "local_account") return "The default local admin account only works in local development. Sign in with your own operator account.";
  return value?.message || fallback;
}
