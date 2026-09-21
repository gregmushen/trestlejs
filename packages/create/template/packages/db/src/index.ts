import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as authSchema from "./auth-schema.js";
import * as billingSchema from "./billing-schema.js";
import * as emailSchema from "./email-schema.js";
import * as tenantSchema from "./tenant-schema.js";

export * from "./auth-schema.js";
export * from "./billing-schema.js";
export * from "./email-schema.js";
export * from "./tenant-schema.js";
export * from "./tenancy.js";

const schema = { ...authSchema, ...billingSchema, ...emailSchema, ...tenantSchema };

export type DatabaseDriver = "neon-http" | "postgres-js";

export function createDatabase(connectionString: string, driver: DatabaseDriver = "neon-http") {
  if (driver === "neon-http") {
    return drizzleNeon(neon(connectionString), { schema });
  }

  const client = postgres(connectionString, {
    max: 1,
    idle_timeout: 1,
    prepare: false,
  });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDatabase>;
