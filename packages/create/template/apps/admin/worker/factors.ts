import { passkey } from "@better-auth/passkey";
import type { BetterAuthPlugin } from "better-auth";
import { twoFactor } from "better-auth/plugins";

/**
 * The operator sign-in factors, which only the platform admin enables: TOTP
 * with backup codes (Better Auth encrypts the secret and codes at rest) and
 * passkeys bound to the admin origin. They live here so the customer Worker
 * never bundles WebAuthn.
 */
export function adminFactorPlugins(webOrigin: string): BetterAuthPlugin[] {
  return [
    passkey({ rpID: new URL(webOrigin).hostname, rpName: "__TRESTLE_PROJECT_NAME__", origin: webOrigin }),
    twoFactor({ issuer: "__TRESTLE_PROJECT_NAME__" }),
  ];
}
