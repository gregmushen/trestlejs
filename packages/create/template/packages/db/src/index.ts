import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as authSchema from "./auth-schema.js";
import * as artifactSchema from "./artifact-schema.js";
import * as billingSchema from "./billing-schema.js";
import * as emailSchema from "./email-schema.js";
import * as tenantSchema from "./tenant-schema.js";
import * as outboxSchema from "./outbox-schema.js";

export * from "./auth-schema.js";
export * from "./artifact-schema.js";
export * from "./artifacts.js";
export * from "./billing-schema.js";
export * from "./email-schema.js";
export * from "./roles.js";
export * from "./tenant-schema.js";
export * from "./outbox-schema.js";
export * from "./outbox.js";
export * from "./inbox.js";
export * from "./tenancy.js";

const schema = { ...authSchema, ...artifactSchema, ...billingSchema, ...emailSchema, ...tenantSchema, ...outboxSchema };

export type DatabaseDriver = "neon-http" | "neon-serverless" | "postgres-js";

export function createDatabase(connectionString: string, driver: DatabaseDriver = "neon-serverless") {
  if (driver !== "postgres-js") {
    if (typeof WebSocket === "undefined") throw new Error("Neon serverless transactions require a WebSocket implementation");
    neonConfig.webSocketConstructor = WebSocket;
    const pool = new Pool({ connectionString, max: 1, idleTimeoutMillis: 1_000 });
    return drizzleNeon({ client: pool, schema });
  }

  const client = postgres(connectionString, {
    max: 1,
    idle_timeout: 1,
    prepare: false,
  });
  return drizzle(client, { schema });
}

export function tenantConnectionString(connectionString: string, organizationId: string, options: { readOnly?: boolean } = {}): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(organizationId)) throw new Error("Invalid organization identifier");
  const url = new URL(connectionString);
  const existing = url.searchParams.get("options");
  url.searchParams.set("options", [existing, "-c role=trestle_app", `-c app.organization_id=${organizationId}`, options.readOnly ? "-c default_transaction_read_only=on" : undefined].filter(Boolean).join(" "));
  return url.toString();
}

export function createTenantDatabase(connectionString: string, driver: DatabaseDriver | undefined, organizationId: string, options: { readOnly?: boolean } = {}) {
  return createDatabase(tenantConnectionString(connectionString, organizationId, options), driver);
}

export type Database = ReturnType<typeof createDatabase>;
