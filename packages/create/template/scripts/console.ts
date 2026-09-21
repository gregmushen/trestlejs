import repl from "node:repl";

import { createAuth, type AuthEnvironment } from "../packages/auth/src/index.js";
import { createDatabase, type DatabaseDriver } from "../packages/db/src/index.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const environment = process.env.TRESTLE_ENV ?? "local";
const mode = process.env.TRESTLE_CONSOLE_MODE ?? "READ ONLY";
const tenant = process.env.TRESTLE_CONSOLE_TENANT || undefined;
const driver = (process.env.DATABASE_DRIVER ?? "neon-http") as DatabaseDriver;
const databaseURL = required("DATABASE_URL");
const db = createDatabase(databaseURL, driver);
const authEnvironment: AuthEnvironment = {
  DATABASE_URL: databaseURL,
  DATABASE_DRIVER: driver,
  BETTER_AUTH_SECRET: required("BETTER_AUTH_SECRET"),
  ...(process.env.BETTER_AUTH_URL ? { BETTER_AUTH_URL: process.env.BETTER_AUTH_URL } : {}),
};
const auth = createAuth(authEnvironment);

const server = repl.start({
  prompt: `__TRESTLE_PROJECT_NAME__ [${environment}${tenant ? ` tenant=${tenant}` : ""} ${mode}]> `,
  useGlobal: false,
  ignoreUndefined: true,
});

server.context.db = db;
server.context.auth = auth;
server.context.environment = environment;
server.context.tenant = tenant;
server.context.mode = mode;
server.context.help = () => ({ db: "Drizzle database", auth: "Better Auth instance", tenant, environment, mode });

console.log("Available: db, auth, tenant, environment, mode, help() — credential values are intentionally not exposed.");
