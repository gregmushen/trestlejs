import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const prefix = `acl-${Date.now()}`;
const orgA = `${prefix}-a`;
const orgB = `${prefix}-b`;
const stamp = String(Date.now()).slice(-13);
const keyId = (organization: string) => `K${organization === orgA ? "a" : "b"}${stamp}x`;

async function as<T>(role: "trestle_app" | "trestle_platform", organizationId: string | undefined, work: (transaction: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return await sql!.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${role}`);
    if (organizationId) await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
    return await work(transaction);
  }) as T;
}

const tenantTables = ["application_role", "application_role_assignment", "service_account", "api_key", "scope_profile", "api_key_usage", "subscription_override", "subscription_change", "usage_aggregate", "audit_event"] as const;

suite("forced RLS for access control and commercial tables", () => {
  beforeAll(async () => {
    for (const organization of [orgA, orgB]) {
      await sql!`insert into application_role (organization_id, key, name, permissions, created_by) values (${organization}, 'auditor', 'Auditor', '{resource.read}', 'test')`;
      await sql!`insert into application_role_assignment (organization_id, user_id, role, granted_by) values (${organization}, 'user-1', 'editor', 'test')`;
      await sql!`insert into service_account (id, organization_id, name, application_roles, created_by) values (${`${organization}-sa`}, ${organization}, 'bot', '{editor}', 'test')`;
      await sql!`insert into api_key (id, organization_id, service_account_id, environment, display_prefix, verifier, scopes, created_by) values (${keyId(organization)}, ${organization}, ${`${organization}-sa`}, 'local', 'tr_dev_x', ${`verifier-${organization}`}, '{resource.read}', 'test')`;
      await sql!`insert into scope_profile (organization_id, name, scopes) values (${organization}, 'read', '{resource.read}')`;
      await sql!`insert into api_key_usage (organization_id, api_key_id, day, requests) values (${organization}, ${keyId(organization)}, current_date, 1)`;
      await sql!`insert into subscription_override (id, organization_id, code, values, reason, author, effective_at) values (${`${organization}-ovr`}, ${organization}, 'team.members', '{"maximum": 40}', 'contract', 'op', now())`;
      await sql!`insert into subscription_change (id, organization_id, to_plan_version, effective_at, reason, author) values (${`${organization}-chg`}, ${organization}, 'business@1', now(), 'upgrade', 'op')`;
      await sql!`insert into usage_aggregate (organization_id, feature_code, period_start, period_end, quantity) values (${organization}, 'api.requests', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 5)`;
      await sql!`insert into audit_event (name, actor_type, actor_id, organization_id, target_type, target_id, outcome, environment, correlation_id) values ('test.event', 'user', 'user-1', ${organization}, 'test', 't', 'succeeded', 'local', 'c')`;
    }
    await sql!`insert into audit_event (name, actor_type, actor_id, organization_id, target_type, target_id, outcome, environment, correlation_id) values ('test.platform', 'user', 'op', null, 'test', ${prefix}, 'succeeded', 'local', 'c')`;
  });

  afterAll(async () => {
    for (const table of [...tenantTables].reverse()) {
      if (table === "audit_event") continue;
      await sql!.unsafe(`delete from ${table} where organization_id like $1`, [`${prefix}%`]);
    }
    await sql!.end();
  });

  it("isolates every tenant-owned table by tenant context", async () => {
    for (const table of tenantTables) {
      const organizations = await as("trestle_app", orgA, (transaction) => transaction.unsafe(`select distinct organization_id from ${table} where organization_id like $1`, [`${prefix}%`]));
      expect(organizations.map((row) => row.organization_id), table).toEqual([orgA]);
      const none = await as("trestle_app", undefined, (transaction) => transaction.unsafe(`select 1 from ${table} where organization_id like $1`, [`${prefix}%`]));
      expect(none, `${table} without tenant context`).toHaveLength(0);
    }
  });

  it("rejects cross-tenant writes on application-role assignments and service accounts", async () => {
    await expect(as("trestle_app", orgA, (transaction) => transaction`insert into application_role_assignment (organization_id, user_id, role, granted_by) values (${orgB}, 'intruder', 'app_admin', 'x')`)).rejects.toThrow();
    expect((await as("trestle_app", orgA, (transaction) => transaction`update application_role_assignment set revoked_at = now() where organization_id = ${orgB}`)).count).toBe(0);
    expect((await as("trestle_app", orgA, (transaction) => transaction`update service_account set status = 'suspended' where organization_id = ${orgB}`)).count).toBe(0);
  });

  it("never exposes API-key verifiers to runtime roles except through the single-key resolver", async () => {
    await expect(as("trestle_app", orgA, (transaction) => transaction`select verifier from api_key`)).rejects.toThrow(/permission denied/u);
    await expect(as("trestle_platform", undefined, (transaction) => transaction`select verifier from api_key`)).rejects.toThrow(/permission denied/u);
    const [resolved] = await as("trestle_app", undefined, (transaction) => transaction`select * from trestle_resolve_api_key(${keyId(orgB)})`);
    expect(resolved).toMatchObject({ organization_id: orgB, verifier: `verifier-${orgB}`, service_account_status: "active", service_account_roles: ["editor"] });
    expect(await as("trestle_app", undefined, (transaction) => transaction`select * from trestle_resolve_api_key('unknown')`)).toHaveLength(0);
  });

  it("keeps audit history append-only and hides platform events from tenants", async () => {
    await expect(as("trestle_app", orgA, (transaction) => transaction`update audit_event set name = 'x' where organization_id = ${orgA}`)).rejects.toThrow(/permission denied/u);
    await expect(as("trestle_platform", undefined, (transaction) => transaction`delete from audit_event where target_id = ${prefix}`)).rejects.toThrow(/permission denied/u);
    await expect(as("trestle_app", orgA, (transaction) => transaction`insert into audit_event (name, actor_type, actor_id, organization_id, target_type, target_id, outcome, environment, correlation_id) values ('x', 'user', 'u', null, 't', 't', 'succeeded', 'local', 'c')`)).rejects.toThrow();
    expect(await as("trestle_app", orgA, (transaction) => transaction`select 1 from audit_event where organization_id is null and target_id = ${prefix}`)).toHaveLength(0);
    expect(await as("trestle_platform", undefined, (transaction) => transaction`select 1 from audit_event where target_id = ${prefix}`)).toHaveLength(1);
  });

  it("gives the tenant runtime no platform tables beyond the plan catalog", async () => {
    expect((await as("trestle_app", orgA, (transaction) => transaction`select plan from plan_version`)).length).toBeGreaterThanOrEqual(3);
    for (const table of ["platform_role_assignment", "support_session", "provider_reconciliation"]) {
      await expect(as("trestle_app", orgA, (transaction) => transaction.unsafe(`select 1 from ${table}`)), table).rejects.toThrow(/permission denied/u);
    }
  });

  it("lets the platform role read across tenants but never credentials", async () => {
    const organizations = await as("trestle_platform", undefined, (transaction) => transaction`select distinct organization_id from service_account where organization_id like ${`${prefix}%`} order by organization_id`);
    expect(organizations.map((row) => row.organization_id)).toEqual([orgA, orgB]);
    await expect(as("trestle_platform", undefined, (transaction) => transaction`select token from session`)).rejects.toThrow(/permission denied/u);
    await expect(as("trestle_platform", undefined, (transaction) => transaction`select password from account`)).rejects.toThrow(/permission denied/u);
    await expect(as("trestle_platform", undefined, (transaction) => transaction`insert into application_role_assignment (organization_id, user_id, role, granted_by) values (${orgA}, 'op', 'app_admin', 'op')`)).rejects.toThrow(/permission denied/u);
  });
});
