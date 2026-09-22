import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tenantConnectionString } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const prefix = `rls-${Date.now()}-`;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;

suite("forced PostgreSQL tenant isolation", () => {
  beforeAll(async () => {
    await sql!`insert into tenant_record (organization_id, name) values ('org-a', ${`${prefix}a`}), ('org-b', ${`${prefix}b`})`;
  });

  afterAll(async () => {
    await sql!`delete from tenant_record where name like ${`${prefix}%`}`;
    await sql!`delete from organization_entitlement where organization_id in ('billing-org-a', 'billing-org-b')`;
    await sql!`delete from organization_subscription where organization_id in ('billing-org-a', 'billing-org-b')`;
    await sql!.end();
  });

  it("applies the same forced isolation to billing projections and entitlements", async () => {
    await sql!`insert into organization_subscription (organization_id, provider, plan, status) values ('billing-org-a', 'local', 'pro', 'active'), ('billing-org-b', 'local', 'starter', 'active')`;
    await sql!`insert into organization_entitlement (organization_id, entitlement) values ('billing-org-a', 'workflows.advanced'), ('billing-org-b', 'article.basic')`;
    await sql!.begin(async (transaction) => {
      await transaction`set local role trestle_app`;
      await transaction`select set_config('app.organization_id', 'billing-org-a', true)`;
      expect((await transaction`select organization_id from organization_subscription order by organization_id`).map((row) => row.organization_id)).toEqual(["billing-org-a"]);
      expect((await transaction`select entitlement from organization_entitlement`).map((row) => row.entitlement)).toEqual(["workflows.advanced"]);
      expect((await transaction`update organization_subscription set plan = 'business' where organization_id = 'billing-org-b'`).count).toBe(0);
    });
  });

  it("fails closed without tenant context", async () => {
    await sql!.begin(async (transaction) => {
      await transaction`set local role trestle_app`;
      const rows = await transaction`select name from tenant_record where name like ${`${prefix}%`}`;
      expect(rows).toHaveLength(0);
    });
  });

  it("cannot read, update, delete, or insert another tenant's rows", async () => {
    await sql!.begin(async (transaction) => {
      await transaction`set local role trestle_app`;
      await transaction`select set_config('app.organization_id', 'org-a', true)`;
      const rows = await transaction`select organization_id from tenant_record where name like ${`${prefix}%`}`;
      expect(rows.map((row) => row.organization_id)).toEqual(["org-a"]);
      expect((await transaction`update tenant_record set name = 'forbidden' where organization_id = 'org-b'`).count).toBe(0);
      expect((await transaction`delete from tenant_record where organization_id = 'org-b'`).count).toBe(0);
    });
    await expect(sql!.begin(async (transaction) => {
      await transaction`set local role trestle_app`;
      await transaction`select set_config('app.organization_id', 'org-a', true)`;
      await transaction`insert into tenant_record (organization_id, name) values ('org-b', 'forbidden')`;
    })).rejects.toThrow();
  });

  it("enforces the restricted role on tenant-scoped runtime connections", async () => {
    const tenantSql = postgres(tenantConnectionString(connectionString!, "org-a"), { max: 1, prepare: false });
    try {
      expect((await tenantSql`select organization_id from tenant_record where name like ${`${prefix}%`}`).map((row) => row.organization_id)).toEqual(["org-a"]);
      expect((await tenantSql`update tenant_record set name = 'forbidden' where organization_id = 'org-b'`).count).toBe(0);
      await expect(tenantSql`insert into tenant_record (organization_id, name) values ('org-b', 'forbidden')`).rejects.toThrow();
    } finally {
      await tenantSql.end();
    }
  });
});
