import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlatformDatabase } from "./index.js";
import { grantEntitlementOverride, listPlatformSubscriptions, platformCommercialDetail, revokeEntitlementOverride } from "./platform-commercial.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `com${Date.now()}`;
const organizationId = `${run}-org`;
const correlationId = `${run}-corr`;
const context = (reason: string, now?: Date) => ({ actor: { type: "platform_operator" as const, id: `${run}-operator` }, reason, environment: "local", correlationId, ...(now ? { now } : {}) });

async function as<T>(role: "trestle_app" | "trestle_platform", work: (transaction: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return await sql!.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${role}`);
    if (role === "trestle_app") await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
    return await work(transaction);
  }) as T;
}

async function failure(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) { return `${(error as Error).message} ${((error as { cause?: Error }).cause?.message ?? "")}`; }
  return "resolved";
}

suite("platform commercial controls", () => {
  beforeAll(async () => {
    await sql!`insert into organization (id, name, slug, created_at) values (${organizationId}, 'Commercial', ${organizationId}, now())`;
    await sql!`insert into organization_subscription (organization_id, provider, provider_customer_id, plan, status) values (${organizationId}, 'stripe', 'cus_secret', 'pro', 'active')`;
    await sql!`insert into organization_entitlement (organization_id, entitlement) values (${organizationId}, 'article.basic')`;
  });

  afterAll(async () => {
    await sql!`delete from audit_event where correlation_id = ${correlationId}`;
    await sql!`delete from organization_entitlement_override where organization_id = ${organizationId}`;
    await sql!`delete from organization_entitlement where organization_id = ${organizationId}`;
    await sql!`delete from organization_subscription where organization_id = ${organizationId}`;
    await sql!`delete from organization where id = ${organizationId}`;
    await sql!.end();
  });

  it("grants, supersedes, and revokes overrides as tombstones with audited internal reasons", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    expect((await listPlatformSubscriptions(platform, { limit: 200 })).find((row) => row.organizationId === organizationId)).toMatchObject({ plan: "pro", status: "active" });
    await grantEntitlementOverride(platform, { organizationId, entitlement: "support.priority", enabled: true }, context("internal: churn-risk retention offer", new Date(Date.now() - 2_000)));
    await grantEntitlementOverride(platform, { organizationId, entitlement: "support.priority", enabled: false }, context("contract amended", new Date(Date.now() - 1_000)));
    await expect(grantEntitlementOverride(platform, { organizationId: `${run}-missing`, entitlement: "support.priority", enabled: true }, context("x"))).rejects.toThrow("does not exist");
    let detail = await platformCommercialDetail(platform, organizationId);
    expect(detail.planEntitlements).toEqual(["article.basic"]);
    expect(detail.overrides.map((override) => [override.enabled, override.removalReason])).toEqual([[false, null], [true, "superseded by a newer override"]]);
    await revokeEntitlementOverride(platform, { organizationId, entitlement: "support.priority" }, context("contract ended"));
    await expect(revokeEntitlementOverride(platform, { organizationId, entitlement: "support.priority" }, context("again"))).rejects.toThrow("no active override");
    detail = await platformCommercialDetail(platform, organizationId);
    expect(detail.overrides.every((override) => override.removedAt !== null)).toBe(true);
    const events = await sql!`select name, organization_id, reason from audit_event where correlation_id = ${correlationId} order by occurred_at`;
    expect(events.map((event) => event.name)).toEqual(["platform.entitlement_override.granted", "platform.entitlement_override.granted", "platform.entitlement_override.revoked"]);
    expect(events[0]).toMatchObject({ organization_id: organizationId, reason: "internal: churn-risk retention offer" });
  });

  it("lets tenant runtimes read overrides but never write them, and the platform only insert or tombstone", async () => {
    expect((await as("trestle_app", async (transaction) => await transaction`select entitlement from organization_entitlement_override`)).length).toBeGreaterThan(0);
    expect(await failure(as("trestle_app", async (transaction) => await transaction`insert into organization_entitlement_override (organization_id, entitlement, enabled, reason, author_id) values (${organizationId}, 'members.unlimited', true, 'self-grant', 'tenant')`))).toMatch(/permission denied/u);
    expect(await failure(as("trestle_app", async (transaction) => await transaction`update organization_entitlement_override set enabled = true`))).toMatch(/permission denied/u);
    expect(await failure(as("trestle_app", async (transaction) => await transaction`delete from organization_entitlement_override`))).toMatch(/permission denied/u);
    expect(await failure(as("trestle_platform", async (transaction) => await transaction`delete from organization_entitlement_override where organization_id = ${organizationId}`))).toMatch(/permission denied/u);
    expect(await failure(as("trestle_platform", async (transaction) => await transaction`update organization_entitlement_override set enabled = true where organization_id = ${organizationId}`))).toMatch(/permission denied/u);
    // A removed override cannot be revived.
    expect((await as("trestle_platform", async (transaction) => await transaction`update organization_entitlement_override set removed_at = null, removed_by = null, removal_reason = null where organization_id = ${organizationId}`)).count).toBe(0);
    expect(await failure(as("trestle_platform", async (transaction) => await transaction`insert into organization_entitlement_override (organization_id, entitlement, enabled, reason, author_id, removed_at, removed_by, removal_reason) values (${organizationId}, 'x.y', true, 'r', 'a', now(), 'a', 'r')`))).toMatch(/row-level security/u);
    expect(await failure(as("trestle_platform", async (transaction) => await transaction`select provider_customer_id from organization_subscription limit 1`))).toMatch(/permission denied/u);
  });
});
