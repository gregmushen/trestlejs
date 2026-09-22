import { createAuth } from "./src/index.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const auth = createAuth({
  DATABASE_URL: requiredEnvironment("DATABASE_URL"),
  BETTER_AUTH_SECRET: requiredEnvironment("BETTER_AUTH_SECRET"),
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  DATABASE_DRIVER: process.env.DATABASE_DRIVER === "neon-http" || process.env.DATABASE_DRIVER === "neon-serverless" ? "neon-serverless" : "postgres-js",
  EMAIL_DELIVERY_MODE: "local",
  APP_ENV: "local",
});
