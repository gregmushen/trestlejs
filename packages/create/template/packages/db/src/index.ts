import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as accessSchema from "./access-schema.js";
import * as auditSchema from "./audit-schema.js";
import * as platformSchema from "./platform-schema.js";
import * as authSchema from "./auth-schema.js";
import * as artifactSchema from "./artifact-schema.js";
import * as artifactMaintenanceSchema from "./artifact-maintenance-schema.js";
import * as billingSchema from "./billing-schema.js";
import * as emailSchema from "./email-schema.js";
import * as tenantSchema from "./tenant-schema.js";
import * as outboxSchema from "./outbox-schema.js";
import * as webhookSchema from "./webhook-schema.js";
import * as webhookProjectionSchema from "./webhook-projection-schema.js";
import * as webhookAttemptSchema from "./webhook-attempt-schema.js";
import * as webhookSecretSchema from "./webhook-secret-schema.js";

export * from "./access-schema.js";
export * from "./application-roles.js";
export * from "./audit-schema.js";
export * from "./audit.js";
export * from "./platform-schema.js";
export * from "./platform-roles.js";
export * from "./platform-operations.js";
export * from "./platform-commercial.js";
export * from "./machine-access-schema.js";
export * from "./machine-access.js";
export * from "./support-schema.js";
export * from "./support-sessions.js";
export * from "./regional-schema.js";
export * from "./regional.js";
export * from "./auth-schema.js";
export * from "./artifact-schema.js";
export * from "./artifact-maintenance-schema.js";
export * from "./artifact-maintenance.js";
export * from "./artifacts.js";
export * from "./billing-schema.js";
export * from "./email-schema.js";
export * from "./roles.js";
export * from "./tenant-schema.js";
export * from "./outbox-schema.js";
export * from "./webhook-schema.js";
export * from "./webhook-projection-schema.js";
export * from "./webhook-projection.js";
export * from "./webhook-attempt-schema.js";
export * from "./webhook-local.js";
export * from "./webhook-claims.js";
export * from "./webhook-native.js";
export * from "./webhook-recovery.js";
export * from "./webhook-inspection.js";
export * from "./webhook-replay.js";
export * from "./webhook-settlement.js";
export * from "./webhook-work.js";
export * from "./webhook-retention.js";
export * from "./webhook-secret-schema.js";
export * from "./webhook-secrets.js";
export * from "./webhook-signing.js";
export * from "./outbox.js";
export * from "./inbox.js";
export * from "./tenancy.js";

const schema = { ...accessSchema, ...auditSchema, ...platformSchema, ...authSchema, ...artifactSchema, ...artifactMaintenanceSchema, ...billingSchema, ...emailSchema, ...tenantSchema, ...outboxSchema, ...webhookSchema, ...webhookProjectionSchema, ...webhookAttemptSchema, ...webhookSecretSchema };

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
    // Wrangler may not reuse I/O across requests. Release an idle socket
    // promptly instead of retaining one pool per request for a full second.
    idle_timeout: 0.05,
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

/**
 * The platform admin's connection: assumes trestle_platform, never trestle_app,
 * and sets no tenant. Platform reads are limited to explicit grants and policies.
 */
export function platformConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  const existing = url.searchParams.get("options");
  if (existing && /(?:^|\s)-c\s*role=/u.test(existing)) throw new Error("The platform connection string must not already select a database role");
  url.searchParams.set("options", [existing, "-c role=trestle_platform"].filter(Boolean).join(" "));
  return url.toString();
}

export function createPlatformDatabase(connectionString: string, driver: DatabaseDriver | undefined) {
  return createDatabase(platformConnectionString(connectionString), driver);
}

export type Database = ReturnType<typeof createDatabase>;
