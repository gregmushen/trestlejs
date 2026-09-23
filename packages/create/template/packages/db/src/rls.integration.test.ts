import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, PostgresArtifactMetadataRepository, tenantConnectionString } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const prefix = `rls-${Date.now()}-`;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;

suite("forced PostgreSQL tenant isolation", () => {
  beforeAll(async () => {
    await sql!`insert into tenant_record (organization_id, name) values ('org-a', ${`${prefix}a`}), ('org-b', ${`${prefix}b`})`;
  });

  afterAll(async () => {
    await sql!`delete from artifact_metadata where id in ('artifact-a', 'artifact-b')`;
    await sql!`delete from tenant_record where name like ${`${prefix}%`}`;
    await sql!`delete from organization_entitlement_override where organization_id in ('billing-org-a', 'billing-org-b')`;
    await sql!`delete from organization_entitlement where organization_id in ('billing-org-a', 'billing-org-b')`;
    await sql!`delete from organization_subscription where organization_id in ('billing-org-a', 'billing-org-b')`;
    await sql!.end();
  });

  it("applies the same forced isolation to billing projections and entitlements", async () => {
    await sql!`insert into organization_subscription (organization_id, provider, plan, status) values ('billing-org-a', 'local', 'pro', 'active'), ('billing-org-b', 'local', 'starter', 'active')`;
    await sql!`insert into organization_entitlement (organization_id, entitlement) values ('billing-org-a', 'workflows.advanced'), ('billing-org-b', 'article.basic')`;
    await sql!`insert into organization_entitlement_override (organization_id, entitlement, enabled, reason, author_id) values ('billing-org-a', 'support.priority', true, 'contract', 'operator-1'), ('billing-org-b', 'support.priority', false, 'review', 'operator-1')`;
    await sql!.begin(async (transaction) => {
      await transaction`set local role trestle_app`;
      await transaction`select set_config('app.organization_id', 'billing-org-a', true)`;
      expect((await transaction`select organization_id from organization_subscription order by organization_id`).map((row) => row.organization_id)).toEqual(["billing-org-a"]);
      expect((await transaction`select entitlement from organization_entitlement`).map((row) => row.entitlement)).toEqual(["workflows.advanced"]);
      expect((await transaction`select reason from organization_entitlement_override`).map((row) => row.reason)).toEqual(["contract"]);
      expect((await transaction`update organization_subscription set plan = 'business' where organization_id = 'billing-org-b'`).count).toBe(0);
    });
  });

  it("applies forced tenant isolation to R2 artifact metadata", async () => {
    await sql!`insert into artifact_metadata (id,organization_id,storage_key,content_type,size) values ('artifact-a','org-a','org-a/a','text/plain',1),('artifact-b','org-b','org-b/b','text/plain',1)`;
    await sql!.begin(async (transaction) => {
      await transaction`set local role trestle_app`;
      await transaction`select set_config('app.organization_id', 'org-a', true)`;
      expect((await transaction`select id from artifact_metadata order by id`).map((row) => row.id)).toEqual(["artifact-a"]);
      expect((await transaction`delete from artifact_metadata where id='artifact-b'`).count).toBe(0);
    });
  });

  it("does not mutate another tenant's artifact metadata on an identifier collision", async () => {
    const id = `${prefix}artifact-collision`;
    const repository = new PostgresArtifactMetadataRepository(createDatabase(connectionString!, "postgres-js"));
    try {
      await repository.put({ id, organizationId: "org-a", key: "org-a/original", contentType: "text/plain", size: 1, createdAt: new Date() });
      await expect(repository.put({ id, organizationId: "org-b", key: "org-b/replacement", contentType: "text/plain", size: 2, createdAt: new Date() })).rejects.toThrow("unavailable");
      await expect(repository.put({ id, organizationId: "org-a", key: "org-a/replacement", contentType: "text/plain", size: 2, createdAt: new Date() })).rejects.toThrow("unavailable");
      expect(await repository.get("org-a", id)).toMatchObject({ key: "org-a/original", size: 1 });
      expect(await repository.discard("org-b", id, "org-a/original")).toBe(false);
      expect(await repository.discard("org-a", id, "org-a/replacement")).toBe(false);
      expect(await repository.get("org-a", id)).not.toBeNull();
    } finally {
      await sql!`delete from artifact_metadata where id = ${id}`;
    }
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
