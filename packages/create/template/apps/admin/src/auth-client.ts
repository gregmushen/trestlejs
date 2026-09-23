import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

const create = () => createAuthClient({ baseURL: window.location.origin, plugins: [twoFactorClient(), passkeyClient()] });
let client: ReturnType<typeof create> | undefined;

/** Better Auth against the admin origin; the admin Worker serves /api/auth for platform operators. */
export function authClient() {
  client ??= create();
  return client;
}

export type AssuranceLevel = "password" | "mfa" | "phishing_resistant";

/**
 * Re-authenticates the operator to at least `level`. A password alone is
 * enough locally; a second factor or a passkey is required elsewhere. Each
 * path creates a fresh session whose assurance the server records.
 */
export type ReauthResult = { ok: true } | { ok: false; needsCode: true } | { ok: false; error: string };

export async function reauthenticateWithPassword(email: string, password: string): Promise<ReauthResult> {
  const result = await authClient().signIn.email({ email, password });
  if (result.error) return { ok: false, error: result.error.message ?? "Re-authentication failed" };
  if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return { ok: false, needsCode: true };
  return { ok: true };
}

export async function verifySecondFactor(code: string, kind: "totp" | "backup"): Promise<ReauthResult> {
  const result = kind === "totp" ? await authClient().twoFactor.verifyTotp({ code: code.trim() }) : await authClient().twoFactor.verifyBackupCode({ code: code.trim() });
  return result.error ? { ok: false, error: result.error.message ?? "That code was not accepted" } : { ok: true };
}

export async function reauthenticateWithPasskey(): Promise<ReauthResult> {
  const result = await authClient().signIn.passkey();
  return result?.error ? { ok: false, error: result.error.message ?? "Passkey verification failed" } : { ok: true };
}
