import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertRuntimeRole, bootstrapRuntimeRole, configurePlatformRole, configureRuntimeRole, inspectRuntimeRole, verifyRuntimeRoleDataAccess } from "./roles.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const runtimeRole = `trestle_runtime_test_${Date.now()}`;
const runtimePassword = `test-${crypto.randomUUID()}`;
const admin = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
let adminRole = "";

suite("production PostgreSQL runtime role", () => {
  beforeAll(async () => {
    const [record] = await admin!<{ current_user: string }[]>`select current_user`;
    if (!record) throw new Error("Unable to inspect test database role");
    adminRole = record.current_user;
  });

  afterAll(async () => {
    await admin!`drop owned by ${admin!(runtimeRole)}`;
    await admin!`drop role if exists ${admin!(runtimeRole)}`;
    await admin!.end();
  });

  it("grants only the restricted application role", async () => {
    await expect(bootstrapRuntimeRole(connectionString!, runtimeRole, runtimePassword)).resolves.toEqual({ role: runtimeRole, created: true });
    await expect(bootstrapRuntimeRole(connectionString!, runtimeRole, runtimePassword)).resolves.toEqual({ role: runtimeRole, created: false });
    const configured = await configureRuntimeRole(connectionString!, runtimeRole);
    expect(configured).toEqual({ role: runtimeRole, canLogin: true, superuser: false, bypassRls: false, memberOfApplicationRole: true, memberOfPlatformRole: false });
    const url = new URL(connectionString!);
    url.username = runtimeRole;
    url.password = runtimePassword;
    const inspected = await inspectRuntimeRole(url.toString());
    expect(inspected).toEqual(configured);
    expect(() => assertRuntimeRole(inspected, runtimeRole)).not.toThrow();
    await expect(verifyRuntimeRoleDataAccess(url.toString())).resolves.toBeUndefined();
  });

  it("never lets the tenant runtime role also assume the platform role", async () => {
    await expect(configurePlatformRole(connectionString!, runtimeRole)).rejects.toThrow("tenant runtime role");
    const platformLogin = `${runtimeRole}_admin`;
    await admin!.unsafe(`create role ${platformLogin} login nosuperuser nobypassrls`);
    try {
      expect(await configurePlatformRole(connectionString!, platformLogin)).toMatchObject({ memberOfPlatformRole: true, memberOfApplicationRole: false });
      await expect(configureRuntimeRole(connectionString!, platformLogin)).rejects.toThrow("can assume trestle_platform");
    } finally {
      await admin!.unsafe(`drop role if exists ${platformLogin}`);
    }
  });

  it("rejects privileged or malformed runtime roles", async () => {
    await expect(configureRuntimeRole(connectionString!, adminRole)).rejects.toThrow("bypass row-level security");
    await expect(configureRuntimeRole(connectionString!, "bad role")).rejects.toThrow("Invalid PostgreSQL runtime role name");
  });
});
