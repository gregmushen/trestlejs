import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { adminApiOrigin } from "./api";

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
 */
export type ReauthResult = { ok: true } | { ok: false; needsCode: true } | { ok: false; error: string };

export async function reauthenticateWithPassword(email: string, password: string): Promise<ReauthResult> {
  const result = await authClient().signIn.email({ email, password });
  if (result.error) return { ok: false, error: result.error.message ?? "Sign-in failed" };
  // With an authenticator enrolled, Better Auth answers with a two-factor challenge and no session yet.
  if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return { ok: false, needsCode: true };
  return { ok: true };
}

/**
 * Completes a password sign-in's two-factor challenge. Never trusts the device:
 * a trust-device cookie would let later step-ups skip the second factor and
 * reach only password assurance.
 */
export async function verifySecondFactor(code: string, kind: "totp" | "backup"): Promise<ReauthResult> {
  const body = { code: code.trim(), trustDevice: false };
  const result = kind === "totp" ? await authClient().twoFactor.verifyTotp(body) : await authClient().twoFactor.verifyBackupCode(body);
  return result.error ? { ok: false, error: result.error.message ?? "That code was not accepted" } : { ok: true };
}

/** Signs in with a passkey, which the server records as phishing-resistant assurance. */
export async function reauthenticateWithPasskey(): Promise<ReauthResult> {
  const result = await authClient().signIn.passkey();
  return result?.error ? { ok: false, error: result.error.message ?? "Passkey verification failed" } : { ok: true };
}
