import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, nextArtifactMaintenanceOrganizations } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const prefix = `maintenance-${Date.now()}-`;
const ids = [`${prefix}a`, `${prefix}b`, `${prefix}c`] as const;

suite("bounded artifact maintenance cursor", () => {
  beforeAll(async () => {
    for (const id of ids) {
      await sql!`insert into organization (id, name, slug, created_at) values (${id}, ${id}, ${id}, now())`;
    }
  });

  afterAll(async () => {
    await sql!`delete from artifact_maintenance_cursor where name = 'incomplete-artifacts'`;
    await sql!`delete from organization where id in (${ids[0]}, ${ids[1]}, ${ids[2]})`;
    await sql!.end();
  });

  it("pages through every organization, wraps, and rejects unbounded scans", async () => {
    const database = createDatabase(connectionString!, "postgres-js");
    expect(await nextArtifactMaintenanceOrganizations(database, 2)).toEqual(ids.slice(0, 2));
    expect(await nextArtifactMaintenanceOrganizations(database, 2)).toEqual(ids.slice(2));
    expect(await nextArtifactMaintenanceOrganizations(database, 2)).toEqual(ids.slice(0, 2));
    await expect(nextArtifactMaintenanceOrganizations(database, 101)).rejects.toThrow("Invalid artifact maintenance page size");
  });
});
