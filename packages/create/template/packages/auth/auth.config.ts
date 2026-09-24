import { existsSync } from "node:fs";

import type { BetterAuthPlugin } from "better-auth";
import { twoFactor } from "better-auth/plugins";

import { createAuth } from "./src/index.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// Better Auth CLI schema generation only. The platform admin owns the sign-in factors
// (apps/admin/worker/factors.ts); include them when it exists so the generated schema keeps
// `passkey`, `two_factor`, and `user.twoFactorEnabled`. Without the admin, TOTP's tables still apply.
const webOrigin = process.env.ADMIN_ORIGIN ?? "http://localhost:42070";
const adminFactors = new URL("../../apps/admin/worker/factors.ts", import.meta.url);
const factors: BetterAuthPlugin[] = existsSync(adminFactors)
  ? (await import(adminFactors.href) as { adminFactorPlugins: (origin: string) => BetterAuthPlugin[] }).adminFactorPlugins(webOrigin)
  : [twoFactor({ issuer: "__TRESTLE_PROJECT_NAME__" })];

export const auth = createAuth({
  DATABASE_URL: requiredEnvironment("DATABASE_URL"),
  BETTER_AUTH_SECRET: requiredEnvironment("BETTER_AUTH_SECRET"),
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  DATABASE_DRIVER: process.env.DATABASE_DRIVER === "neon-http" || process.env.DATABASE_DRIVER === "neon-serverless" ? "neon-serverless" : "postgres-js",
  EMAIL_DELIVERY_MODE: "local",
  APP_ENV: "local",
}, { plugins: factors });
