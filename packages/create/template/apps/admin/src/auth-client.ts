import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { adminApiOrigin } from "./api";
import { networkErrorMessage, type StepUpIdentity } from "./step-up";

export type { AssuranceLevel } from "./step-up";

const create = () => createAuthClient({ baseURL: adminApiOrigin || window.location.origin, plugins: [twoFactorClient(), passkeyClient()] });
let client: ReturnType<typeof create> | undefined;

/** Better Auth against the admin API origin; the admin Worker serves /api/auth for platform operators. */
export function authClient() {
  client ??= create();
  return client;
}

/**
 * Signs the operator in with a password. A second factor is requested only
 * when the account has one enrolled; the server records the session's assurance.
 * These helpers never throw: better-fetch throws on a network failure, which
 * becomes an error result.
 */
export type ReauthResult = { ok: true } | { ok: false; needsCode: true } | { ok: false; error: string };

export async function reauthenticateWithPassword(email: string, password: string): Promise<ReauthResult> {
  try {
    const result = await authClient().signIn.email({ email, password });
    if (result.error) return { ok: false, error: result.error.message ?? "Sign-in failed" };
    // With an authenticator enrolled, Better Auth answers with a two-factor challenge and no session yet.
    if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return { ok: false, needsCode: true };
    return { ok: true };
  } catch {
    return { ok: false, error: networkErrorMessage };
  }
}

/**
 * Completes a password sign-in's two-factor challenge. Never trusts the device:
 * a trust-device cookie would let later step-ups skip the second factor and
 * reach only password assurance.
 */
export async function verifySecondFactor(code: string, kind: "totp" | "backup"): Promise<ReauthResult> {
  try {
    const body = { code: code.trim(), trustDevice: false };
    const result = kind === "totp" ? await authClient().twoFactor.verifyTotp(body) : await authClient().twoFactor.verifyBackupCode(body);
    return result.error ? { ok: false, error: result.error.message ?? "That code was not accepted" } : { ok: true };
  } catch {
    return { ok: false, error: networkErrorMessage };
  }
}

/** Signs in with a passkey, which the server records as phishing-resistant assurance. */
export async function reauthenticateWithPasskey(): Promise<ReauthResult> {
  try {
    const result = await authClient().signIn.passkey();
    return result?.error ? { ok: false, error: result.error.message ?? "Passkey verification failed" } : { ok: true };
  } catch {
    return { ok: false, error: networkErrorMessage };
  }
}

/** Reads who the current session belongs to, bypassing any cached session, and signs it out; both throw when they fail. */
export const stepUpIdentity: StepUpIdentity = {
  currentUserId: async () => {
    const result = await authClient().getSession({ query: { disableCookieCache: true } });
    if (result.error) throw new Error(result.error.message ?? "Could not read the session");
    return result.data?.user.id ?? null;
  },
  signOut: async () => {
    const result = await authClient().signOut();
    if (result.error) throw new Error(result.error.message ?? "Sign-out failed");
  },
};
