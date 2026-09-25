import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { adminApiOrigin } from "./api";

const create = () => createAuthClient({ baseURL: adminApiOrigin || window.location.origin, plugins: [twoFactorClient()] });
let client: ReturnType<typeof create> | undefined;

/** Better Auth against the admin API origin; the admin Worker serves /api/auth for platform operators. */
export function authClient() {
  client ??= create();
  return client;
}

export type AssuranceLevel = "password" | "mfa" | "phishing_resistant";

/**
 * Signs the operator in with a password. A second factor is requested only
 * when the account has one enrolled; the server records the session's assurance.
 */
export type ReauthResult = { ok: true } | { ok: false; needsCode: true } | { ok: false; error: string };

export async function reauthenticateWithPassword(email: string, password: string): Promise<ReauthResult> {
  const result = await authClient().signIn.email({ email, password });
  if (result.error) return { ok: false, error: result.error.message ?? "Sign-in failed" };
  if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return { ok: false, needsCode: true };
  return { ok: true };
}

export async function verifySecondFactor(code: string, kind: "totp" | "backup"): Promise<ReauthResult> {
  const result = kind === "totp" ? await authClient().twoFactor.verifyTotp({ code: code.trim() }) : await authClient().twoFactor.verifyBackupCode({ code: code.trim() });
  return result.error ? { ok: false, error: result.error.message ?? "That code was not accepted" } : { ok: true };
}

/** Passkeys are not enabled for the platform admin yet; step-up that requires one fails closed. */
export async function reauthenticateWithPasskey(): Promise<ReauthResult> {
  return { ok: false, error: "Passkey sign-in is not enabled for this admin" };
}
