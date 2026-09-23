import postgres from "postgres";
import { tenantConnectionString } from "../packages/db/src/index.js";
import { artifactReferenceCheck, recoveryCheckStatus, type RecoveryCheck } from "./recovery-evidence.js";
import { createR2RecoveryHead, verifyArtifactObjects, type ReadyArtifactReference } from "./recovery-r2.js";

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const runtimeUrl = process.env.DATABASE_URL;
if (!migrationUrl || !runtimeUrl) throw new Error("DATABASE_MIGRATION_URL and DATABASE_URL are required");
const migration = postgres(migrationUrl, { max: 1, prepare: false });
const checks: RecoveryCheck[] = [];

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
    if (!first || !second) throw new Error("two organizations are required for adversarial tenant-isolation verification");
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
  try {
    const [row] = await migration<{ count: number }[]>`select count(*)::int as count from artifact_metadata where upload_state='ready' and deleted_at is null`;
    if (!row || !Number.isSafeInteger(row.count)) throw new Error("could not count ready artifact references");
    const policy = process.env.TRESTLE_ARTIFACT_POLICY;
    if (row.count === 0 || policy !== "metadata-reference-verification") {
      checks.push(artifactReferenceCheck(policy, row.count));
    } else {
      try {
        const provider = createR2RecoveryHead({
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
          accessKeyId: process.env.R2_RECOVERY_ACCESS_KEY_ID ?? "",
          secretAccessKey: process.env.R2_RECOVERY_SECRET_ACCESS_KEY ?? "",
          bucket: process.env.TRESTLE_ARTIFACT_BUCKET ?? "",
        });
        try {
          const result = await verifyArtifactObjects(row.count, async (afterId, limit) => {
            const records = await migration<ReadyArtifactReference[]>`select id, organization_id as "organizationId", storage_key as key, content_type as "contentType", size::float8 as size
              from artifact_metadata where upload_state='ready' and deleted_at is null and id > ${afterId} order by id limit ${limit}`;
            return records;
          }, provider.head);
          checks.push(artifactReferenceCheck(policy, row.count, result));
        } finally { provider.close(); }
      } catch {
        checks.push({ id: "artifacts.references", status: "fail", evidence: "R2 reference verification was unavailable or incomplete" });
      }
    }
  } catch { checks.push({ id: "artifacts.references", status: "fail", evidence: "ready artifact references could not be enumerated" }); }
} finally { await migration.end(); }

process.stdout.write(`${JSON.stringify({ status: recoveryCheckStatus(checks), startedAt: process.env.TRESTLE_VERIFY_STARTED_AT ?? null, completedAt: new Date().toISOString(), checks })}\n`);
