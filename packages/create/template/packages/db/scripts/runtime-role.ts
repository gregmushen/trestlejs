import { assertRuntimeRole, configureRuntimeRole, inspectRuntimeRole } from "../src/roles.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const operation = process.argv[2];
const expectedRole = required("DATABASE_RUNTIME_ROLE");

if (operation === "configure") {
  const status = await configureRuntimeRole(required("DATABASE_MIGRATION_URL"), expectedRole);
  assertRuntimeRole(status, expectedRole);
  console.log(`Configured restricted PostgreSQL runtime role ${status.role}`);
} else if (operation === "verify") {
  const status = await inspectRuntimeRole(required("DATABASE_URL"));
  assertRuntimeRole(status, expectedRole);
  console.log(`Verified restricted PostgreSQL runtime role ${status.role}`);
} else {
  throw new Error("Expected configure or verify");
}
