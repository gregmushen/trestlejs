import postgres from "postgres";
import { tenantConnectionString } from "../packages/db/src/index.js";

type Check = { id: string; status: "pass" | "fail" | "unverifiable"; evidence: string };
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const runtimeUrl = process.env.DATABASE_URL;
if (!migrationUrl || !runtimeUrl) throw new Error("DATABASE_MIGRATION_URL and DATABASE_URL are required");
const migration = postgres(migrationUrl, { max: 1, prepare: false });
const checks: Check[] = [];

async function check(id: string, operation: () => Promise<string>): Promise<void> {
  try { checks.push({ id, status: "pass", evidence: await operation() }); }
  catch (error) { checks.push({ id, status: "fail", evidence: error instanceof Error ? error.message : String(error) }); }
}

try {
  await check("database.reachable", async () => { await migration`select 1`; return "catalog query succeeded"; });
  await check("schema.migrations", async () => { const [row] = await migration<{ count: number }[]>`select count(*)::int as count from drizzle.__drizzle_migrations`; if (!row?.count) throw new Error("no migration history"); return `${row.count} migrations recorded`; });
  await check("auth.integrity", async () => { const [row] = await migration<{ count: number }[]>`select count(*)::int as count from member m left join "user" u on u.id=m.user_id left join organization o on o.id=m.organization_id where u.id is null or o.id is null`; if (row?.count) throw new Error(`${row.count} orphan memberships`); return "memberships reference users and organizations"; });
  await check("role.application", async () => { const [row] = await migration<{ rolbypassrls: boolean; rolsuper: boolean }[]>`select rolbypassrls,rolsuper from pg_roles where rolname='trestle_app'`; if (!row || row.rolbypassrls || row.rolsuper) throw new Error("trestle_app is missing or can bypass RLS"); return "trestle_app is NOBYPASSRLS and NOSUPERUSER"; });
  await check("rls.forced", async () => { const rows = await migration<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in ('tenant_record','organization_subscription','organization_entitlement','organization_entitlement_override','artifact_metadata')`; const unsafe = rows.filter((row) => !row.relrowsecurity || !row.relforcerowsecurity); if (rows.length < 5 || unsafe.length) throw new Error("tenant tables do not all force RLS"); return `${rows.length} tenant tables force RLS`; });
  await check("rls.runtime", async () => {
    const organizations = await migration<{ id: string }[]>`select id from organization order by id limit 2`;
    const first = organizations[0]?.id;
    const second = organizations[1]?.id;
    if (!first || !second) return "fewer than two organizations; tenant isolation is structurally configured but adversarial two-tenant verification is unavailable";
    const tenant = postgres(tenantConnectionString(runtimeUrl, first), { max: 1, prepare: false });
    try {
      const visible = await tenant<{ organization_id: string }[]>`select organization_id from tenant_record`;
      if (visible.some((row) => row.organization_id !== first)) throw new Error("runtime connection crossed tenant boundary");
      if ((await tenant`update tenant_record set name=name where organization_id=${second}`).count !== 0) throw new Error("cross-tenant update succeeded");
      if ((await tenant`delete from tenant_record where organization_id=${second}`).count !== 0) throw new Error("cross-tenant delete succeeded");
      let insertRejected = false;
      try { await tenant`insert into tenant_record (organization_id,name) values (${second},'forbidden')`; } catch { insertRejected = true; }
      if (!insertRejected) throw new Error("cross-tenant insert succeeded");
      return "cross-tenant SELECT, INSERT, UPDATE, and DELETE failed closed";
    } finally { await tenant.end(); }
  });
  checks.push({ id: "artifacts.references", status: "unverifiable", evidence: "database metadata restored; R2 object bytes require the declared provider-specific object verification policy" });
} finally { await migration.end(); }

const failed = checks.filter((item) => item.status === "fail").length;
process.stdout.write(`${JSON.stringify({ status: failed ? "failed" : "passed", startedAt: process.env.TRESTLE_VERIFY_STARTED_AT ?? null, completedAt: new Date().toISOString(), checks })}\n`);
