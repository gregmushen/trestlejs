import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, nextArtifactMaintenanceOrganizations, nextMaintenanceOrganizations } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const prefix = `maintenance-${Date.now()}-`;
const ids = [`${prefix}a`, `${prefix}b`, `${prefix}c`] as const;

suite("bounded artifact maintenance cursor", () => {
  beforeAll(async () => {
    await sql!`delete from artifact_maintenance_cursor where name in ('incomplete-artifacts', 'webhook-payloads')`;
    for (const id of ids) {
      await sql!`insert into organization (id, name, slug, created_at) values (${id}, ${id}, ${id}, now())`;
    }
  });

  afterAll(async () => {
    await sql!`delete from artifact_maintenance_cursor where name = 'incomplete-artifacts'`;
    await sql!`delete from artifact_maintenance_cursor where name = 'webhook-payloads'`;
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
});
