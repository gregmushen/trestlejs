import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, createPlatformDatabase } from "./index.js";
import { activePlatformRoles, grantPlatformRole, PlatformRoleError, revokePlatformRole } from "./platform-roles.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const admin = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `plat${Date.now()}`;
const operator = `${run}-operator`;
const context = (reason = "on-call rotation") => ({ actor: { type: "system" as const, id: "bootstrap" }, reason, environment: "local", correlationId: `${run}-corr` });

async function as<T>(role: "trestle_app" | "trestle_platform", work: (transaction: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return await admin!.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${role}`);
    if (role === "trestle_app") await transaction`select set_config('app.organization_id', ${`${run}-org`}, true)`;
    return await work(transaction);
  }) as T;
}

async function failure(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) { return `${(error as Error).message} ${((error as { cause?: Error }).cause?.message ?? "")}`; }
  return "resolved";
}

suite("platform roles", () => {
  beforeAll(async () => {
    await admin!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${operator}, 'Operator', ${`${operator}@example.test`}, true, now(), now())`;
  });

  afterAll(async () => {
    await admin!`delete from audit_event where correlation_id = ${`${run}-corr`}`;
    await admin!`delete from "user" where id like ${`${run}%`}`;
    await admin!.end();
  });

  it("grants and revokes with a reason, recording each change in audit in the same transaction", async () => {
    const database = createDatabase(connectionString!, "postgres-js");
    await grantPlatformRole(database, { userId: operator, role: "platform_operator" }, context());
    await expect(grantPlatformRole(database, { userId: operator, role: "platform_operator" }, context())).rejects.toBeInstanceOf(PlatformRoleError);
    await expect(grantPlatformRole(database, { userId: operator, role: "security_admin" }, context(" "))).rejects.toThrow("reason");
    expect(await activePlatformRoles(createPlatformDatabase(connectionString!, "postgres-js"), operator)).toEqual(["platform_operator"]);
    await revokePlatformRole(database, { userId: operator, role: "platform_operator" }, context("rotation ended"));
    await expect(revokePlatformRole(database, { userId: operator, role: "platform_operator" }, context("again"))).rejects.toThrow("does not hold");
    expect(await activePlatformRoles(database, operator)).toEqual([]);
    const events = await admin!`select name, actor_type, organization_id, reason, summary from audit_event where correlation_id = ${`${run}-corr`} order by occurred_at`;
    expect(events).toEqual([
      { name: "platform.role.granted", actor_type: "system", organization_id: null, reason: "on-call rotation", summary: { role: "platform_operator" } },
      { name: "platform.role.revoked", actor_type: "system", organization_id: null, reason: "rotation ended", summary: { role: "platform_operator" } },
    ]);
  });

  it("keeps the platform role out of tenant data and tenant runtimes out of platform roles", async () => {
    expect(await failure(as("trestle_app", async (transaction) => await transaction`select id from platform_role_assignment limit 1`))).toMatch(/permission denied/u);
    expect(await failure(as("trestle_app", async (transaction) => await transaction`select id from audit_event where organization_id is null limit 1`))).toBe("resolved");
    expect((await as("trestle_app", async (transaction) => await transaction`select id from audit_event where correlation_id = ${`${run}-corr`}`)).length).toBe(0);
    for (const table of ["application_role_assignment", "webhook_secret_version", "webhook_attempt", "event_inbox", "tenant_record", "session", "account"]) {
      expect(await failure(as("trestle_platform", async (transaction) => await transaction.unsafe(`select 1 from "${table}" limit 1`)))).toMatch(/permission denied/u);
    }
    expect(await failure(as("trestle_platform", async (transaction) => await transaction`select email from "user" limit 1`))).toBe("resolved");
    expect(await failure(as("trestle_platform", async (transaction) => await transaction`select password from account limit 1`))).toMatch(/permission denied/u);
    expect(await failure(as("trestle_platform", async (transaction) => await transaction`update audit_event set outcome = 'failed' where correlation_id = ${`${run}-corr`}`))).toMatch(/permission denied/u);
    expect((await as("trestle_platform", async (transaction) => await transaction`select name from audit_event where correlation_id = ${`${run}-corr`}`)).length).toBe(2);
  });
});
