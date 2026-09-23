import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { advanceArtifactOrphanCursor, artifactOrphanCursorName, artifactReferenceCursorName, createDatabase, createTenantDatabase, getArtifactOrphanCursor, hasArtifactStorageKey, nextArtifactMaintenanceOrganizations, nextArtifactReferenceAuditCandidates, nextMaintenanceOrganizations } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const prefix = `maintenance-${Date.now()}-`;
const ids = [`${prefix}a`, `${prefix}b`, `${prefix}c`] as const;

suite("bounded artifact maintenance cursor", () => {
  beforeAll(async () => {
    await sql!`delete from artifact_maintenance_cursor where name in ('incomplete-artifacts', 'webhook-payloads', 'artifact-reference-organizations', 'artifact-orphan-organizations', ${await artifactReferenceCursorName(ids[0])}, ${await artifactReferenceCursorName(ids[1])}, ${await artifactOrphanCursorName(ids[0])})`;
    for (const id of ids) {
      await sql!`insert into organization (id, name, slug, created_at) values (${id}, ${id}, ${id}, now())`;
    }
  });

  afterAll(async () => {
    await sql!`delete from artifact_maintenance_cursor where name = 'incomplete-artifacts'`;
    await sql!`delete from artifact_maintenance_cursor where name = 'webhook-payloads'`;
    await sql!`delete from artifact_maintenance_cursor where name in ('artifact-reference-organizations', 'artifact-orphan-organizations', ${await artifactReferenceCursorName(ids[0])}, ${await artifactReferenceCursorName(ids[1])}, ${await artifactOrphanCursorName(ids[0])})`;
    await sql!`delete from artifact_metadata where id like ${`${prefix}%`}`;
    await sql!`delete from organization where id in (${ids[0]}, ${ids[1]}, ${ids[2]})`;
    await sql!.end();
  });

  it("pages through every organization, wraps, and rejects unbounded scans", async () => {
    const database = createDatabase(connectionString!, "postgres-js");
    const organizations = (await sql!<{ id: string }[]>`select id from organization order by id`).map(({ id }) => id);
    expect(organizations).toEqual(expect.arrayContaining([...ids]));
    const first = await nextArtifactMaintenanceOrganizations(database, 2);
    expect(first).toEqual(organizations.slice(0, 2));
    expect(await nextMaintenanceOrganizations(database, "webhook-payloads", 1)).toEqual(organizations.slice(0, 1));
    let traversed = [...first];
    while (traversed.length < organizations.length) {
      const page = await nextArtifactMaintenanceOrganizations(database, 2);
      expect(page.length).toBeGreaterThan(0);
      traversed = [...traversed, ...page];
    }
    expect(traversed).toEqual(organizations);
    expect(await nextMaintenanceOrganizations(database, "webhook-payloads", 1)).toEqual(organizations.slice(1, 2));
    expect(await nextArtifactMaintenanceOrganizations(database, 2)).toEqual(organizations.slice(0, 2));
    await expect(nextArtifactMaintenanceOrganizations(database, 101)).rejects.toThrow("Invalid artifact maintenance page size");
    await expect(nextMaintenanceOrganizations(database, "invalid name", 1)).rejects.toThrow("Invalid maintenance cursor name");
  });

  it("audits only ready references with a separate bounded cursor", async () => {
    const database = createDatabase(connectionString!, "postgres-js");
    const tenantDatabase = createTenantDatabase(connectionString!, "postgres-js", ids[0]);
    const readyId = `${prefix}ready`;
    const readyB = `${prefix}ready-b`;
    const readyC = `${prefix}ready-c`;
    const pendingId = `${prefix}pending`;
    const deletedId = `${prefix}deleted`;
    const foreignId = `${prefix}foreign`;
    await sql!`insert into artifact_metadata (id, organization_id, storage_key, content_type, size, upload_state) values
      (${readyId}, ${ids[0]}, ${`${ids[0]}/${readyId}`}, 'text/plain', 1, 'ready'),
      (${readyB}, ${ids[0]}, ${`${ids[0]}/${readyB}`}, 'text/plain', 1, 'ready'),
      (${readyC}, ${ids[0]}, ${`${ids[0]}/${readyC}`}, 'text/plain', 1, 'ready'),
      (${pendingId}, ${ids[0]}, ${`${ids[0]}/${pendingId}`}, 'text/plain', 1, 'pending'),
      (${deletedId}, ${ids[0]}, ${`${ids[0]}/${deletedId}`}, 'text/plain', 1, 'deleted'),
      (${foreignId}, ${ids[1]}, ${`${ids[1]}/${foreignId}`}, 'text/plain', 1, 'ready')`;
    const first = await nextArtifactReferenceAuditCandidates(database, tenantDatabase, ids[0], 2);
    expect(first).toEqual([{ id: readyId, organizationId: ids[0] }, { id: readyB, organizationId: ids[0] }]);
    expect(first.some((item) => item.id === pendingId || item.id === deletedId || item.id === foreignId)).toBe(false);
    const second = await nextArtifactReferenceAuditCandidates(database, tenantDatabase, ids[0], 2);
    expect(second).toEqual([{ id: readyC, organizationId: ids[0] }]);
    expect(await nextArtifactReferenceAuditCandidates(database, tenantDatabase, ids[0], 2)).toEqual(first);
    expect(await nextArtifactReferenceAuditCandidates(database, createTenantDatabase(connectionString!, "postgres-js", ids[1]), ids[1], 100)).toContainEqual({ id: foreignId, organizationId: ids[1] });
    expect(await nextArtifactMaintenanceOrganizations(database, 1)).toHaveLength(1);
    await expect(nextArtifactReferenceAuditCandidates(database, tenantDatabase, ids[0], 0)).rejects.toThrow("Invalid artifact reference audit page size");
    await expect(nextArtifactReferenceAuditCandidates(database, tenantDatabase, ids[0], 101)).rejects.toThrow("Invalid artifact reference audit page size");
    await expect(artifactReferenceCursorName("invalid tenant")).rejects.toThrow("Invalid artifact audit organization");
  });

  it("checks physical keys under forced tenant RLS and CAS-advances opaque R2 cursors", async () => {
    const database = createDatabase(connectionString!, "postgres-js");
    const ownId = `${prefix}orphan-pending`;
    const foreignId = `${prefix}orphan-foreign`;
    const retiredId = `${prefix}orphan-retired`;
    const own = `${ids[0]}/${ownId}`;
    const foreign = `${ids[1]}/${foreignId}`;
    const retired = `${ids[0]}/${retiredId}`;
    await sql!`insert into artifact_metadata (id, organization_id, storage_key, content_type, size, upload_state) values
      (${ownId}, ${ids[0]}, ${own}, 'text/plain', 1, 'pending'),
      (${foreignId}, ${ids[1]}, ${foreign}, 'text/plain', 1, 'ready')`;
    await sql!`insert into artifact_metadata (id, organization_id, storage_key, content_type, size, upload_state, deleted_at) values
      (${retiredId}, ${ids[0]}, ${retired}, 'text/plain', 1, 'deleted', now())`;
    const ownTenant = createTenantDatabase(connectionString!, "postgres-js", ids[0], { readOnly: true });
    const foreignTenant = createTenantDatabase(connectionString!, "postgres-js", ids[1], { readOnly: true });
    // A pending reservation protects a write that has reached R2 but has not
    // yet finalized in PostgreSQL.
    expect(await hasArtifactStorageKey(ownTenant, ids[0], own)).toBe(true);
    expect(await hasArtifactStorageKey(ownTenant, ids[0], retired)).toBe(false);
    expect(await hasArtifactStorageKey(ownTenant, ids[0], `${ids[0]}/missing`)).toBe(false);
    expect(await hasArtifactStorageKey(foreignTenant, ids[1], foreign)).toBe(true);
    await expect(hasArtifactStorageKey(ownTenant, ids[0], foreign)).rejects.toThrow("outside the tenant prefix");
    expect(await getArtifactOrphanCursor(database, ids[0])).toBe("");
    expect(await advanceArtifactOrphanCursor(database, ids[0], "", "opaque-r2-token")).toBe(true);
    expect(await advanceArtifactOrphanCursor(database, ids[0], "", "stale-token")).toBe(false);
    expect(await getArtifactOrphanCursor(database, ids[0])).toBe("opaque-r2-token");
    expect(await advanceArtifactOrphanCursor(database, ids[0], "opaque-r2-token", "")).toBe(true);
  });
});
