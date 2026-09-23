import { assertPlatformRole, configurePlatformRole, inspectPlatformRole } from "../src/roles.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const operation = process.argv[2];
const expectedRole = required("DATABASE_ADMIN_RUNTIME_ROLE");

// The platform admin Worker logs in as a distinct role granted only trestle_platform.
if (operation === "configure") {
  const status = await configurePlatformRole(required("DATABASE_MIGRATION_URL"), expectedRole);
  assertPlatformRole(status, expectedRole);
  console.log(`Configured platform admin PostgreSQL role ${status.role}`);
} else if (operation === "verify") {
  const status = await inspectPlatformRole(required("DATABASE_ADMIN_URL"));
  assertPlatformRole(status, expectedRole);
  console.log(`Verified platform admin PostgreSQL role ${status.role}`);
} else {
  throw new Error("Expected configure or verify");
}
