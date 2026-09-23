import { RegionalService, type OperationContext } from "@__TRESTLE_PROJECT_NAME__/domain";
import { applicationRegionalConfig } from "@__TRESTLE_PROJECT_NAME__/regional";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresRegionalRepository } from "./postgres-regional-repository.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const admin = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `regional${Date.now()}`;
const orgA = `${run}-a`;
const orgB = `${run}-b`;
const userA = `${run}-sarah`;
const userB = `${run}-mo`;
const config = applicationRegionalConfig({ language: "en", locale: "en-US", timeZone: "UTC", currency: "USD" }).config;
const context = (organizationId: string, actor = userA): OperationContext => ({ organizationId, actor: { type: "user", id: actor }, correlationId: `${run}-corr`, environment: "local", now: new Date() });
const service = (organizationId: string) => new RegionalService(config, new PostgresRegionalRepository(connectionString!, "postgres-js", organizationId));

async function as<T>(role: "trestle_app" | "trestle_platform", settings: Record<string, string>, work: (transaction: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return await admin!.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${role}`);
    for (const [name, value] of Object.entries(settings)) await transaction`select set_config(${name}, ${value}, true)`;
    return await work(transaction);
  }) as T;
}

suite("PostgresRegionalRepository", () => {
  beforeAll(async () => {
    for (const id of [userA, userB]) await admin!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, ${id}, ${`${id}@example.test`}, true, now(), now())`;
  });

  afterAll(async () => {
    await admin!`delete from organization_regional_settings where organization_id like ${`${run}%`}`;
    await admin!`delete from user_regional_preference where user_id like ${`${run}%`}`;
    await admin!`delete from audit_event where correlation_id = ${`${run}-corr`}`;
    await admin!`delete from outbox_message where correlation_id = ${`${run}-corr`}`;
    await admin!`delete from "user" where id like ${`${run}%`}`;
    await admin!.end();
  });

  it("persists organization settings per tenant with an audit record in the same transaction", async () => {
    await service(orgA).updateOrganization(context(orgA), { timeZone: "America/Los_Angeles", currency: "CAD" });
    await service(orgB).updateOrganization(context(orgB), { timeZone: "Europe/Paris" });
    expect((await service(orgA).organization()).configured).toEqual({ language: null, locale: null, timeZone: "America/Los_Angeles", currency: "CAD" });
    expect((await service(orgB).organization()).effective.timeZone).toEqual({ value: "Europe/Paris", source: "organization" });
    const [audit] = await admin!`select name, actor_type, summary from audit_event where organization_id = ${orgA} and correlation_id = ${`${run}-corr`}`;
    expect(audit).toMatchObject({ name: "organization.regional_settings.updated", actor_type: "user", summary: { timeZone: { from: null, to: "America/Los_Angeles" }, currency: { from: null, to: "CAD" } } });
  });

  it("denies cross-tenant reads and writes through forced RLS", async () => {
    const visible = await as("trestle_app", { "app.organization_id": orgA }, async (transaction) => await transaction`select organization_id from organization_regional_settings where organization_id like ${`${run}%`}`);
    expect(visible.map((row) => row.organization_id)).toEqual([orgA]);
    await expect(as("trestle_app", { "app.organization_id": orgA }, async (transaction) => await transaction`insert into organization_regional_settings (organization_id, updated_by) values (${orgB}, 'attacker') on conflict (organization_id) do update set time_zone = 'UTC'`)).rejects.toThrow(/row-level security/u);
    const untouched = await as("trestle_app", { "app.organization_id": orgA }, async (transaction) => await transaction`update organization_regional_settings set time_zone = 'UTC' where organization_id = ${orgB}`);
    expect(untouched.count).toBe(0);
  });

  it("keeps each user's preferences private to that user, across organizations", async () => {
    await service(orgA).updateUser(context(orgA, userA), userA, { timeZone: "America/New_York", language: "en" });
    expect((await service(orgB).user(userA)).effective.timeZone).toEqual({ value: "America/New_York", source: "user" });
    expect((await service(orgA).user(userB)).effective.timeZone).toEqual({ value: "America/Los_Angeles", source: "organization" });
    const leaked = await as("trestle_app", { "app.organization_id": orgA, "app.user_id": userB }, async (transaction) => await transaction`select user_id from user_regional_preference where user_id = ${userA}`);
    expect(leaked).toHaveLength(0);
    const unscoped = await as("trestle_app", { "app.organization_id": orgA }, async (transaction) => await transaction`select user_id from user_regional_preference where user_id like ${`${run}%`}`);
    expect(unscoped).toHaveLength(0);
    await service(orgA).updateUser(context(orgA, userA), userA, { timeZone: null, language: null });
    expect((await admin!`select count(*)::int as count from user_regional_preference where user_id = ${userA}`)[0]!.count).toBe(0);
  });

  it("lets the platform role read regional state but never write it directly", async () => {
    const rows = await as("trestle_platform", {}, async (transaction) => await transaction`select organization_id from organization_regional_settings where organization_id like ${`${run}%`} order by organization_id`);
    expect(rows.map((row) => row.organization_id)).toEqual([orgA, orgB]);
    await expect(as("trestle_platform", {}, async (transaction) => await transaction`update organization_regional_settings set time_zone = 'UTC' where organization_id = ${orgA}`)).rejects.toThrow(/permission denied/u);
  });

  it("never rewrites historical timestamps when the organization zone changes", async () => {
    const [before] = await admin!`select occurred_at from audit_event where organization_id = ${orgA} and correlation_id = ${`${run}-corr`} order by occurred_at limit 1`;
    await service(orgA).updateOrganization(context(orgA), { timeZone: "Asia/Tokyo", currency: "CAD" });
    const [after] = await admin!`select occurred_at from audit_event where organization_id = ${orgA} and correlation_id = ${`${run}-corr`} order by occurred_at limit 1`;
    expect((after!.occurred_at as Date).toISOString()).toBe((before!.occurred_at as Date).toISOString());
  });
});
