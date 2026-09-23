import { randomUUID } from "node:crypto";

import { platformRoles } from "@__TRESTLE_PROJECT_NAME__/authz";

import { createDatabase, grantPlatformRole, listPlatformRoleGrants, revokePlatformRole, user } from "../src/index.js";
import { eq } from "drizzle-orm";

/**
 * Operator bootstrap and break-glass access for platform roles. It runs with
 * the migration connection, validates roles against the reviewed catalog,
 * requires a reason, and records every change as a system audit event.
 */
const [operation, email, role, ...reasonWords] = process.argv.slice(2);
const connectionString = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_MIGRATION_URL or DATABASE_URL is required");
const database = createDatabase(connectionString, "postgres-js");
const context = { actor: { type: "system" as const, id: "bootstrap" }, reason: reasonWords.join(" "), environment: process.env.TRESTLE_ENV ?? "local", correlationId: `platform-admin:${randomUUID()}` };

if (operation === "list") {
  process.stdout.write(`${JSON.stringify(await listPlatformRoleGrants(database))}\n`);
} else if (operation === "grant" || operation === "revoke") {
  if (!email || !role) throw new Error(`${operation} requires an email and a platform role`);
  if (!platformRoles.get(role)) throw new Error(`Unknown platform role ${role}; expected one of ${platformRoles.list().map(({ key }) => key).join(", ")}`);
  const [target] = await database.select({ id: user.id }).from(user).where(eq(user.email, email.toLowerCase())).limit(1);
  if (!target) throw new Error("No user has that email address; the operator must sign up first");
  await (operation === "grant" ? grantPlatformRole : revokePlatformRole)(database, { userId: target.id, role }, context);
  process.stdout.write(`${JSON.stringify({ operation, role, userId: target.id, correlationId: context.correlationId })}\n`);
} else {
  throw new Error("Expected list, grant, or revoke");
}
process.exit(0);
