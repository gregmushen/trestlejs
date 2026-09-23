import { applicationRoles, parseApiKey } from "@__TRESTLE_PROJECT_NAME__/authz";
import { ApplicationRoleService, OrganizationRoleService, ServiceAccountService, type OperationContext } from "@__TRESTLE_PROJECT_NAME__/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresTenantAccessRepository } from "./postgres-tenant-access-repository.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const admin = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `repo${Date.now()}`;
const orgA = `${run}-a`;
const orgB = `${run}-b`;
const context = (organizationId: string): OperationContext => ({ organizationId, actor: { type: "user", id: `${run}-owner` }, correlationId: `${run}-corr`, environment: "local", now: new Date() });

suite("PostgresTenantAccessRepository", () => {
  beforeAll(async () => {
    for (const [id, name] of [[`${run}-owner`, "Olive"], [`${run}-member`, "Mo"]] as const) {
      await admin!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, ${name}, ${`${id}@example.test`}, true, now(), now())`;
    }
    for (const organization of [orgA, orgB]) {
      await admin!`insert into organization (id, name, slug, created_at) values (${organization}, ${organization}, ${organization}, now())`;
      await admin!`insert into member (id, organization_id, user_id, role, created_at) values (${`${organization}-owner`}, ${organization}, ${`${run}-owner`}, 'owner', now()), (${`${organization}-member`}, ${organization}, ${`${run}-member`}, 'member', now())`;
    }
  });

  afterAll(async () => {
    for (const table of ["api_key_usage", "api_key", "service_account", "application_role_assignment", "application_role", "scope_profile"]) await admin!.unsafe(`delete from ${table} where organization_id like $1`, [`${run}%`]);
    await admin!`delete from outbox_message where correlation_id = ${`${run}-corr`}`;
    await admin!`delete from member where organization_id like ${`${run}%`}`;
    await admin!`delete from organization where id like ${`${run}%`}`;
    await admin!`delete from "user" where id like ${`${run}%`}`;
    await admin!.end();
  });

  it("persists application-role assignments separately from organization roles, per tenant", async () => {
    const repository = new PostgresTenantAccessRepository(connectionString!, "postgres-js", orgA);
    await new ApplicationRoleService(repository).assignUserRoles(context(orgA), `${run}-member`, ["editor", "reader"]);
    await new ApplicationRoleService(repository).assignUserRoles(context(orgA), `${run}-member`, ["editor"]);
    expect((await repository.listApplicationRoleAssignments(`${run}-member`)).map(({ role }) => role)).toEqual(["editor"]);
    expect((await repository.listMembers()).find((member) => member.userId === `${run}-member`)?.organizationRoles).toEqual(["member"]);
    expect(await new PostgresTenantAccessRepository(connectionString!, "postgres-js", orgB).listApplicationRoleAssignments(`${run}-member`)).toEqual([]);
  });

  it("changes organization roles through the membership row and audits the change", async () => {
    const repository = new PostgresTenantAccessRepository(connectionString!, "postgres-js", orgA);
    await new OrganizationRoleService(repository).setMemberRoles(context(orgA), ["owner"], `${orgA}-member`, ["billing_admin"]);
    const [row] = await admin!`select role from member where id = ${`${orgA}-member`}`;
    expect(row?.role).toBe("billing_admin");
    expect((await repository.listAudit(10)).map((entry) => entry.name)).toContain("access.organization_roles.changed");
  });

  it("mints, rotates, and revokes keys atomically with audit and outbox records but no plaintext", async () => {
    const repository = new PostgresTenantAccessRepository(connectionString!, "postgres-js", orgA);
    const service = new ServiceAccountService(repository);
    const account = await service.create(context(orgA), { name: "deploy-bot", applicationRoles: ["editor"] });
    const minted = await service.mintKey(context(orgA), account.id, { scopes: ["resource.read", "resource.write"], allowedCidrs: ["10.0.0.0/8"], rateLimitPerMinute: 60 }, 5);
    const rotated = await service.rotateKey(context(orgA), minted.key.id, 1, 5);
    await service.revokeKey(context(orgA), rotated.key.id, "test cleanup");
    const keys = await repository.listApiKeys(account.id);
    expect(keys.find((key) => key.id === minted.key.id)).toMatchObject({ rotatedTo: rotated.key.id, allowedCidrs: ["10.0.0.0/8"], rateLimitPerMinute: 60 });
    expect(keys.find((key) => key.id === rotated.key.id)?.revokedAt).toBeInstanceOf(Date);
    const [stored] = await admin!`select verifier from api_key where id = ${minted.key.id}`;
    expect(stored?.verifier).toMatch(/^[0-9a-f]{64}$/u);
    const everything = JSON.stringify([await admin!`select * from api_key where organization_id = ${orgA}`, await admin!`select * from audit_event where organization_id = ${orgA}`, await admin!`select * from outbox_message where correlation_id = ${`${run}-corr`}`]);
    for (const token of [minted.token, rotated.token]) expect(everything).not.toContain(token!.split("_").at(-1));
    const events = (await admin!`select event_name from outbox_message where correlation_id = ${`${run}-corr`} order by occurred_at`).map((row) => row.event_name);
    expect(events).toEqual(expect.arrayContaining(["access.service_account.created", "access.api_key.minted", "access.api_key.rotated", "access.api_key.revoked"]));
    const [resolved] = await admin!.begin(async (transaction) => { await transaction`set local role trestle_app`; return await transaction`select * from trestle_resolve_api_key(${parseApiKey(minted.token!)!.publicId})`; });
    expect(resolved).toMatchObject({ organization_id: orgA, service_account_roles: ["editor"] });
    expect(applicationRoles.resolve(resolved!.service_account_roles as string[]).permissions.has("resource.write")).toBe(true);
  });

  it("rejects a mutation whose context names another tenant", async () => {
    const repository = new PostgresTenantAccessRepository(connectionString!, "postgres-js", orgA);
    await expect(new ServiceAccountService(repository).create(context(orgB), { name: "x", applicationRoles: ["reader"] })).rejects.toThrow("does not match");
  });
});
