import { existsSync } from "node:fs";

import type { BetterAuthPlugin } from "better-auth";
import { twoFactor } from "better-auth/plugins";

import { createAuth } from "./src/index.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * The `passkey` model as @better-auth/passkey 1.7.5 declares it, without the WebAuthn runtime. A project
 * without the admin has no passkey plugin, but its migrations keep the `passkey` table (enabling the admin
 * later needs it), so a regenerated auth schema must keep it too. Keep this in step with the plugin's schema.
 */
const passkeySchema: BetterAuthPlugin = {
  id: "passkey-schema",
  schema: { passkey: { fields: {
    name: { type: "string", required: false },
    publicKey: { type: "string", required: true },
    userId: { type: "string", references: { model: "user", field: "id" }, required: true, index: true },
    credentialID: { type: "string", required: true, index: true },
    counter: { type: "number", required: true },
    deviceType: { type: "string", required: true },
    backedUp: { type: "boolean", required: true },
    transports: { type: "string", required: false },
    createdAt: { type: "date", required: false },
    aaguid: { type: "string", required: false },
  } } },
};

// Better Auth CLI schema generation only. The platform admin owns the sign-in factors
// (apps/admin/worker/factors.ts); include them when it exists. Without the admin, TOTP and the
// schema-only passkey model keep `passkey`, `two_factor`, and `user.twoFactorEnabled` in the schema.
const webOrigin = process.env.ADMIN_ORIGIN ?? "http://localhost:42070";
const adminFactors = new URL("../../apps/admin/worker/factors.ts", import.meta.url);
const factors: BetterAuthPlugin[] = existsSync(adminFactors)
  ? (await import(adminFactors.href) as { adminFactorPlugins: (origin: string) => BetterAuthPlugin[] }).adminFactorPlugins(webOrigin)
  : [twoFactor({ issuer: "__TRESTLE_PROJECT_NAME__" }), passkeySchema];

export const auth = createAuth({
  DATABASE_URL: requiredEnvironment("DATABASE_URL"),
  BETTER_AUTH_SECRET: requiredEnvironment("BETTER_AUTH_SECRET"),
  ...(process.env.BETTER_AUTH_URL ? { BETTER_AUTH_URL: process.env.BETTER_AUTH_URL } : {}),
  DATABASE_DRIVER: process.env.DATABASE_DRIVER === "neon-http" || process.env.DATABASE_DRIVER === "neon-serverless" ? "neon-serverless" : "postgres-js",
  EMAIL_DELIVERY_MODE: "local",
  APP_ENV: "local",
}, { plugins: factors });
