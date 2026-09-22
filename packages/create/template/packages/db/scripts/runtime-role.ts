import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";

import { assertRuntimeRole, bootstrapRuntimeRole, configureRuntimeRole, inspectRuntimeRole, verifyRuntimeRoleDataAccess } from "../src/roles.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const operation = process.argv[2];
const expectedRole = required("DATABASE_RUNTIME_ROLE");

if (operation === "bootstrap" || operation === "bootstrap-managed") {
  const migrationUrl = required("DATABASE_MIGRATION_URL");
  const managed = operation === "bootstrap-managed";
  const runtimeUrl = managed ? new URL(migrationUrl) : new URL(required("DATABASE_URL"));
  const password = managed ? randomBytes(32).toString("base64url") : decodeURIComponent(runtimeUrl.password);
  if (!managed && decodeURIComponent(runtimeUrl.username) !== expectedRole) throw new Error(`DATABASE_URL uses ${decodeURIComponent(runtimeUrl.username)}; expected ${expectedRole}`);
  if (!password) throw new Error("DATABASE_URL must contain the runtime role password");
  const result = await bootstrapRuntimeRole(migrationUrl, expectedRole, password);
  if (managed) {
    runtimeUrl.username = expectedRole;
    runtimeUrl.password = password;
    const output = process.env.TRESTLE_RUNTIME_OUTPUT ?? process.env.GITHUB_OUTPUT;
    if (!output) throw new Error("TRESTLE_RUNTIME_OUTPUT or GITHUB_OUTPUT is required");
    if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${runtimeUrl.toString()}`);
    await appendFile(output, `runtime_url=${runtimeUrl.toString()}\n`, { encoding: "utf8", mode: 0o600 });
  }
  console.log(`${result.created ? "Created" : "Updated"} restricted PostgreSQL runtime role ${result.role}`);
} else if (operation === "configure") {
  const status = await configureRuntimeRole(required("DATABASE_MIGRATION_URL"), expectedRole);
  assertRuntimeRole(status, expectedRole);
  console.log(`Configured restricted PostgreSQL runtime role ${status.role}`);
} else if (operation === "verify") {
  const status = await inspectRuntimeRole(required("DATABASE_URL"));
  assertRuntimeRole(status, expectedRole);
  await verifyRuntimeRoleDataAccess(required("DATABASE_URL"));
  console.log(`Verified restricted PostgreSQL runtime role and data access ${status.role}`);
} else {
  throw new Error("Expected bootstrap, bootstrap-managed, configure, or verify");
}
