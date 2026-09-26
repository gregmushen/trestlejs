import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Remote databases such as Neon migrate as a database owner that is not a
 * superuser: a CREATEROLE login without BYPASSRLS. Migrations that hand
 * functions to a dedicated role grant that role to themselves only for the
 * transfer, so every statement needing the membership must run before it is
 * revoked. This applies the whole journal as such an owner.
 *
 * The cluster-wide trestle_* roles may already exist from other suites, so the
 * owner receives only the ADMIN option on them, as PostgreSQL 16+ gives a
 * role's creator when the owner creates them itself.
 */
const adminUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const suffix = randomBytes(6).toString("hex");
export const MIGRATION_OWNER_PREFIX = "trestle_owner_";
const owner = `${MIGRATION_OWNER_PREFIX}${suffix}`;
const ownerPassword = `owner-${randomBytes(12).toString("hex")}`;
const databaseName = `trestle_migrate_owner_${suffix}`;
const createdRoles = ["trestle_app", "trestle_platform", "trestle_retention"];

function withDatabase(url: string, database: string, credentials?: { user: string; password: string }): string {
  const address = new URL(url);
  address.pathname = `/${database}`;
  if (credentials) {
    address.username = credentials.user;
    address.password = credentials.password;
  }
  return address.toString();
}

suite("migrations as a non-superuser database owner", () => {
  const maintenance = adminUrl ? postgres(withDatabase(adminUrl, "postgres"), { max: 1, prepare: false, onnotice: () => undefined }) : undefined;

  afterAll(async () => {
    if (!maintenance) return;
    await maintenance.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await maintenance.unsafe(`drop role if exists "${owner}"`);
    await maintenance.end();
  });

  it("applies every migration and leaves the retention functions executable by the owner", async () => {
    await maintenance!.unsafe(`create role "${owner}" login password '${ownerPassword}' nosuperuser createrole nocreatedb inherit nobypassrls`);
    for (const role of createdRoles) {
      const [existing] = await maintenance!<{ exists: boolean }[]>`select exists (select 1 from pg_roles where rolname = ${role}) as exists`;
      if (existing?.exists) await maintenance!.unsafe(`grant "${role}" to "${owner}" with admin option, inherit false, set false`);
    }
    await maintenance!.unsafe(`create database "${databaseName}" owner "${owner}"`);
    const migrator = postgres(withDatabase(adminUrl!, databaseName, { user: owner, password: ownerPassword }), { max: 1, prepare: false, onnotice: () => undefined });
    try {
      const [role] = await migrator<{ rolsuper: boolean; rolbypassrls: boolean }[]>`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      await migrate(drizzle(migrator), { migrationsFolder });
      const [prunable] = await migrator<{ count: number }[]>`select trestle_count_prunable_outbox_provenance(now() - interval '31 days') as count`;
      expect(prunable?.count).toBe(0);
      const [pruned] = await migrator<{ count: number }[]>`select trestle_prune_outbox_provenance(now() - interval '31 days', 10) as count`;
      expect(pruned?.count).toBe(0);
      const [membership] = await migrator<{ member: boolean }[]>`select pg_has_role(current_user, 'trestle_retention', 'USAGE') as member`;
      expect(membership?.member).toBe(false);
    } finally {
      await migrator.end();
    }
  }, 120_000);
});
