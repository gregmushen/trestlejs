import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as accessSchema from "./access-schema.js";
import * as auditSchema from "./audit-schema.js";
import * as authSchema from "./auth-schema.js";
import * as artifactSchema from "./artifact-schema.js";
import * as billingSchema from "./billing-schema.js";
import * as capabilitySchema from "./capability-schema.js";
import * as commercialSchema from "./commercial-schema.js";
import * as communicationsSchema from "./communications-schema.js";
import * as emailSchema from "./email-schema.js";
import * as identitySchema from "./identity-schema.js";
import * as tenantSchema from "./tenant-schema.js";
import * as outboxSchema from "./outbox-schema.js";
import * as policySchema from "./policy-schema.js";

export * from "./access-schema.js";
export * from "./audit-schema.js";
export * from "./auth-schema.js";
export * from "./artifact-schema.js";
export * from "./artifacts.js";
export * from "./billing-schema.js";
export * from "./capability-schema.js";
export * from "./commercial-schema.js";
export * from "./communications-schema.js";
export * from "./email-schema.js";
export * from "./identity-schema.js";
export * from "./roles.js";
export * from "./sql-runner.js";
export * from "./tenant-schema.js";
export * from "./outbox-schema.js";
export * from "./policy-schema.js";
export * from "./outbox.js";
export * from "./inbox.js";
export * from "./tenancy.js";

const schema = { ...accessSchema, ...auditSchema, ...authSchema, ...artifactSchema, ...billingSchema, ...capabilitySchema, ...commercialSchema, ...communicationsSchema, ...emailSchema, ...identitySchema, ...tenantSchema, ...outboxSchema, ...policySchema };

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

function withOptions(connectionString: string, options: readonly (string | undefined)[]): string {
  const url = new URL(connectionString);
  const existing = url.searchParams.get("options");
  if (existing && /(?:^|\s)-c\s*role=/u.test(existing)) throw new Error("The connection string already selects a database role");
  url.searchParams.set("options", [existing, ...options].filter(Boolean).join(" "));
  return url.toString();
}

export function tenantConnectionString(connectionString: string, organizationId: string, options: { readOnly?: boolean } = {}): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(organizationId)) throw new Error("Invalid organization identifier");
  return withOptions(connectionString, ["-c role=trestle_app", `-c app.organization_id=${organizationId}`, options.readOnly ? "-c default_transaction_read_only=on" : undefined]);
}

/** Restricted application role without tenant context; used only to call narrow SECURITY DEFINER functions. */
export function applicationConnectionString(connectionString: string): string {
  return withOptions(connectionString, ["-c role=trestle_app"]);
}

/** Platform repositories: cross-tenant access through the audited trestle_platform role only. */
export function platformConnectionString(connectionString: string): string {
  return withOptions(connectionString, ["-c role=trestle_platform"]);
}

export function createTenantDatabase(connectionString: string, driver: DatabaseDriver | undefined, organizationId: string, options: { readOnly?: boolean } = {}) {
  return createDatabase(tenantConnectionString(connectionString, organizationId, options), driver);
}

export function createPlatformDatabase(connectionString: string, driver?: DatabaseDriver) {
  return createDatabase(platformConnectionString(connectionString), driver);
}

export type Database = ReturnType<typeof createDatabase>;
