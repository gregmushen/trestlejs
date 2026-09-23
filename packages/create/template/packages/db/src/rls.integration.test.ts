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
    await sql!`delete from subscription_override where organization_id in ('billing-org-a', 'billing-org-b')`;
    await sql!`delete from organization_entitlement where organization_id in ('billing-org-a', 'billing-org-b')`;
    await sql!`delete from organization_subscription where organization_id in ('billing-org-a', 'billing-org-b')`;
    await sql!.end();
  });

  it("applies the same forced isolation to billing projections and entitlements", async () => {
    await sql!`insert into organization_subscription (organization_id, provider, plan, status) values ('billing-org-a', 'local', 'pro', 'active'), ('billing-org-b', 'local', 'starter', 'active')`;
    await sql!`insert into organization_entitlement (organization_id, entitlement) values ('billing-org-a', 'workflows.advanced'), ('billing-org-b', 'article.basic')`;
    await sql!`insert into subscription_override (id, organization_id, code, enabled, reason, author, effective_at) values ('override-billing-a', 'billing-org-a', 'support.priority', true, 'contract', 'operator-1', now()), ('override-billing-b', 'billing-org-b', 'support.priority', false, 'review', 'operator-1', now())`;
    await sql!.begin(async (transaction) => {
      await transaction`set local role trestle_app`;
      await transaction`select set_config('app.organization_id', 'billing-org-a', true)`;
      expect((await transaction`select organization_id from organization_subscription order by organization_id`).map((row) => row.organization_id)).toEqual(["billing-org-a"]);
      expect((await transaction`select entitlement from organization_entitlement`).map((row) => row.entitlement)).toEqual(["workflows.advanced"]);
      expect((await transaction`select reason from subscription_override`).map((row) => row.reason)).toEqual(["contract"]);
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
      expect(await repository.get("org-a", id)).toBeNull();
      await expect(repository.put({ id, organizationId: "org-b", key: "org-b/replacement", contentType: "text/plain", size: 2, createdAt: new Date() })).rejects.toThrow("unavailable");
      await expect(repository.put({ id, organizationId: "org-a", key: "org-a/replacement", contentType: "text/plain", size: 2, createdAt: new Date() })).rejects.toThrow("unavailable");
      expect(await repository.complete("org-b", id, "org-a/original")).toBe(false);
      expect(await repository.complete("org-a", id, "org-a/replacement")).toBe(false);
      expect(await repository.complete("org-a", id, "org-a/original")).toBe(true);
      expect(await repository.get("org-a", id)).toMatchObject({ key: "org-a/original", size: 1 });
      expect(await repository.discard("org-b", id, "org-a/original")).toBe(false);
      expect(await repository.discard("org-a", id, "org-a/replacement")).toBe(false);
      expect(await repository.get("org-a", id)).not.toBeNull();
      expect(await repository.retire("org-b", id, "org-a/original")).toBe(false);
      expect(await repository.remove("org-a", id)).toBe(true);
      expect(await repository.get("org-a", id)).toBeNull();
      await expect(repository.put({ id, organizationId: "org-a", key: "org-a/reuse", contentType: "text/plain", size: 2, createdAt: new Date() })).rejects.toThrow("unavailable");
    } finally {
      await sql!`delete from artifact_metadata where id = ${id}`;
    }
  });

  it("releases only a pending reservation and retains a retired identifier", async () => {
    const pendingId = `${prefix}artifact-pending`;
    const retiredId = `${prefix}artifact-retired`;
    const repository = new PostgresArtifactMetadataRepository(createDatabase(connectionString!, "postgres-js"));
    try {
      await repository.put({ id: pendingId, organizationId: "org-a", key: "org-a/pending", contentType: "text/plain", size: 1, createdAt: new Date() });
      expect(await repository.get("org-a", pendingId)).toBeNull();
      expect(await repository.discard("org-b", pendingId, "org-a/pending")).toBe(false);
      expect(await repository.discard("org-a", pendingId, "org-a/wrong")).toBe(false);
      expect(await repository.discard("org-a", pendingId, "org-a/pending")).toBe(true);
      await repository.put({ id: pendingId, organizationId: "org-a", key: "org-a/retry", contentType: "text/plain", size: 1, createdAt: new Date() });
      await repository.put({ id: retiredId, organizationId: "org-a", key: "org-a/retired", contentType: "text/plain", size: 1, createdAt: new Date() });
      expect(await repository.retire("org-a", retiredId, "org-a/retired")).toBe(true);
      expect(await repository.complete("org-a", retiredId, "org-a/retired")).toBe(false);
      await expect(repository.put({ id: retiredId, organizationId: "org-a", key: "org-a/reuse", contentType: "text/plain", size: 1, createdAt: new Date() })).rejects.toThrow("unavailable");
    } finally {
      await sql!`delete from artifact_metadata where id in (${pendingId}, ${retiredId})`;
    }
  });

  it("claims stale incomplete metadata with exact tenant, key, and cutoff", async () => {
    const staleId = `${prefix}stale-artifact`;
    const recentId = `${prefix}recent-artifact`;
    const repository = new PostgresArtifactMetadataRepository(createDatabase(connectionString!, "postgres-js"));
    const old = new Date("2026-01-01T00:00:00Z");
    const recent = new Date("2026-01-03T00:00:00Z");
    const cutoff = new Date("2026-01-02T00:00:00Z");
    try {
      await repository.put({ id: staleId, organizationId: "org-a", key: "org-a/stale", contentType: "text/plain", size: 1, createdAt: old });
      await repository.put({ id: recentId, organizationId: "org-a", key: "org-a/recent", contentType: "text/plain", size: 1, createdAt: recent });
      expect((await repository.listIncomplete("org-a", cutoff, 10)).map(({ id }) => id)).toEqual([staleId]);
      expect(await repository.listIncomplete("org-b", cutoff, 10)).toEqual([]);
      expect(await repository.claimIncomplete("org-b", staleId, "org-a/stale", cutoff)).toBe(false);
      expect(await repository.claimIncomplete("org-a", staleId, "org-a/wrong", cutoff)).toBe(false);
      expect(await repository.claimIncomplete("org-a", recentId, "org-a/recent", cutoff)).toBe(false);
      expect(await repository.claimIncomplete("org-a", staleId, "org-a/stale", cutoff)).toBe(true);
      expect(await repository.complete("org-a", staleId, "org-a/stale")).toBe(false);
      expect(await repository.get("org-a", staleId)).toBeNull();
      expect(await repository.retire("org-a", staleId, "org-a/stale")).toBe(true);
      expect(await repository.listIncomplete("org-a", cutoff, 10)).toEqual([]);
      await expect(repository.put({ id: staleId, organizationId: "org-a", key: "org-a/reuse", contentType: "text/plain", size: 1, createdAt: recent })).rejects.toThrow("unavailable");
      await expect(repository.listIncomplete("org-a", cutoff, 101)).rejects.toThrow("Invalid artifact recovery");
    } finally {
      await sql!`delete from artifact_metadata where id in (${staleId}, ${recentId})`;
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
