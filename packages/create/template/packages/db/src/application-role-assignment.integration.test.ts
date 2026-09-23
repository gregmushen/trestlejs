import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { activeApplicationRoles, applicationRoleHolders, grantApplicationRoles, listApplicationRoleGrants, replaceApplicationRoles } from "./application-roles.js";
import { createTenantDatabase } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const admin = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `ara${Date.now()}`;
const orgA = `${run}-a`;
const orgB = `${run}-b`;
const userA = `${run}-sam`;
const userB = `${run}-kim`;
const tenant = (organizationId: string) => createTenantDatabase(connectionString!, "postgres-js", organizationId);

async function asApp<T>(organizationId: string | null, work: (transaction: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return await admin!.begin(async (transaction) => {
    await transaction`set local role trestle_app`;
    if (organizationId) await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
    return await work(transaction);
  }) as T;
}

suite("application-role assignments", () => {
  beforeAll(async () => {
    for (const id of [userA, userB]) await admin!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, ${id}, ${`${id}@example.test`}, true, now(), now())`;
  });

  afterAll(async () => {
    await admin!`delete from application_role_assignment where organization_id like ${`${run}%`}`;
    await admin!`delete from "user" where id like ${`${run}%`}`;
    await admin!.end();
  });

  it("grants idempotently and reads only active roles for the tenant", async () => {
    await grantApplicationRoles(tenant(orgA), { organizationId: orgA, userId: userA, roles: ["editor", "app_admin"], grantedBy: "policy:test" });
    await grantApplicationRoles(tenant(orgA), { organizationId: orgA, userId: userA, roles: ["editor"], grantedBy: "policy:test" });
    await grantApplicationRoles(tenant(orgB), { organizationId: orgB, userId: userA, roles: ["reader"], grantedBy: "policy:test" });
    expect(await activeApplicationRoles(tenant(orgA), orgA, userA)).toEqual(["app_admin", "editor"]);
    expect(await activeApplicationRoles(tenant(orgB), orgB, userA)).toEqual(["reader"]);
    expect(await applicationRoleHolders(tenant(orgA), orgA, "app_admin")).toEqual([userA]);
  });

  it("replaces roles by revoking, keeping grant history", async () => {
    const change = await replaceApplicationRoles(tenant(orgA), { organizationId: orgA, userId: userA, roles: ["app_admin", "reader"], actor: "user:test", now: new Date() });
    expect(change).toEqual({ added: ["reader"], removed: ["editor"] });
    expect(await activeApplicationRoles(tenant(orgA), orgA, userA)).toEqual(["app_admin", "reader"]);
    const [history] = await admin!`select revoked_by from application_role_assignment where organization_id = ${orgA} and user_id = ${userA} and role = 'editor'`;
    expect(history).toEqual({ revoked_by: "user:test" });
    expect((await listApplicationRoleGrants(tenant(orgA), orgA)).map(({ role }) => role)).toEqual(["app_admin", "reader"]);
  });

  it("isolates tenants with forced RLS, even when a caller forgets its own predicate", async () => {
    const visible = await asApp(orgA, async (transaction) => await transaction`select distinct organization_id from application_role_assignment where organization_id like ${`${run}%`}`);
    expect(visible.map((row) => row.organization_id)).toEqual([orgA]);
    expect(await asApp(null, async (transaction) => await transaction`select id from application_role_assignment where organization_id like ${`${run}%`}`)).toHaveLength(0);
    await expect(asApp(orgA, async (transaction) => await transaction`insert into application_role_assignment (organization_id, user_id, role, granted_by) values (${orgB}, ${userB}, 'app_admin', 'attacker')`)).rejects.toThrow(/row-level security/u);
    expect((await asApp(orgA, async (transaction) => await transaction`update application_role_assignment set revoked_at = now() where organization_id = ${orgB}`)).count).toBe(0);
    await expect(asApp(orgA, async (transaction) => await transaction`delete from application_role_assignment where organization_id = ${orgA}`)).rejects.toThrow(/permission denied/u);
  });
});
