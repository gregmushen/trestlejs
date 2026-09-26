import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlatformDatabase } from "./index.js";
import { replayWebhookDelivery } from "./platform-operations.js";

/**
 * Migration 0028 gave a migration role without BYPASSRLS unrestricted
 * webhook policies so the platform replay function it owned could see every
 * tenant. Where that role is also the runtime login (older or local setups),
 * application code could read every tenant's webhook rows through them.
 *
 * This suite migrates a fresh database as such an owner: a non-superuser
 * CREATEROLE login without BYPASSRLS that owns the database, as on Neon. The
 * cluster-wide trestle_* roles may already exist (created by the superuser
 * that migrated the shared test database), so the owner is given the ADMIN
 * option, exactly as PostgreSQL 16+ gives a role's creator and nothing more,
 * on the roles whose membership a later migration grants itself for an
 * ownership transfer. Migrations run inside `migrate`, whose failures fail
 * the suite.
 *
 * Published migration 0033 cannot be applied by a non-superuser: it grants
 * EXECUTE on the retention functions after giving them away and dropping the
 * temporary membership. That migration is immutable, so this harness applies
 * it alone with the owner briefly made superuser, then removes the attribute
 * before every later migration, including the one under test.
 */
const adminUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const suffix = randomBytes(6).toString("hex");
const owner = `trestle_owner_${suffix}`;
const ownerPassword = `owner-${randomBytes(12).toString("hex")}`;
const databaseName = `trestle_owner_db_${suffix}`;
// 0033's trestle_retention transfer runs as superuser below, so that role is
// left untouched; other suites assert it has no members at all.
const transferRoles = ["trestle_platform", "trestle_webhook_replay"];
const replaySignature = "trestle_replay_webhook_delivery(text, text, timestamp with time zone, text, text, text, text, text)";
const tenants = { a: `owner-${suffix}-a`, b: `owner-${suffix}-b` };
const day = 86_400_000;
const superuserOnly = new Set(["0033_jazzy_lilith"]);

let maintenance: postgres.Sql | undefined;
let admin: postgres.Sql | undefined;
let ownerUrl = "";
let adminDatabaseUrl = "";

function withDatabase(url: string, database: string, credentials?: { user: string; password: string }): string {
  const address = new URL(url);
  address.pathname = `/${database}`;
  if (credentials) {
    address.username = credentials.user;
    address.password = credentials.password;
  }
  return address.toString();
}

async function failure(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) { return (error as Error).message; }
  return "resolved";
}

async function seedTenant(organizationId: string, provenanceAgeMs: number) {
  const [endpoint] = await admin!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by)
    values (${organizationId}, 'preview', 'Owner test', 'https://customer.example/private', 'active', 'native', 'owner', 'owner') returning id`;
  const sourceEventId = crypto.randomUUID();
  const occurredAt = new Date(Date.now() - provenanceAgeMs);
  await admin!`insert into outbox_message (id, event_name, schema_version, occurred_at, resource_type, resource_id, organization_id, correlation_id, idempotency_key, payload, status, attempts, available_at, processed_at)
    values (${sourceEventId}, 'article.published', 1, ${occurredAt}, 'article', 'a1', ${organizationId}, 'corr', ${sourceEventId}, ${admin!.json({ secret: "payload" })}, 'succeeded', 1, ${occurredAt}, ${occurredAt})`;
  const messageId = `${organizationId}-m`;
  await admin!`insert into webhook_message (id, organization_id, source_event_id, public_event_type, public_version, occurred_at, resource_type, resource_id, envelope, payload_size, retention_class, entitlement_decision, status, correlation_id)
    values (${messageId}, ${organizationId}, ${sourceEventId}, 'article.published', 1, now(), 'article', 'a1', ${admin!.json({ secret: "envelope" })}, 20, 'standard', 'not_required', 'ready', 'corr')`;
  const deliveryId = `${organizationId}-d`;
  await admin!`insert into webhook_delivery (id, organization_id, message_id, endpoint_id, state, attempt_count, terminal_reason, completed_at)
    values (${deliveryId}, ${organizationId}, ${messageId}, ${endpoint!.id}, 'dead', 3, 'http_500', now())`;
  return { organizationId, deliveryId, messageId, endpointId: endpoint!.id };
}

suite("webhook replay under a migration owner without BYPASSRLS", () => {
  beforeAll(async () => {
    maintenance = postgres(withDatabase(adminUrl!, "postgres"), { max: 1, prepare: false, onnotice: () => undefined });
    await maintenance.unsafe(`create role "${owner}" login password '${ownerPassword}' nosuperuser createrole nocreatedb inherit nobypassrls`);
    for (const role of transferRoles) {
      const [existing] = await maintenance<{ exists: boolean }[]>`select exists (select 1 from pg_roles where rolname = ${role}) as exists`;
      if (existing?.exists) await maintenance.unsafe(`grant "${role}" to "${owner}" with admin option, inherit false, set false`);
    }
    await maintenance.unsafe(`create database "${databaseName}" owner "${owner}"`);
    adminDatabaseUrl = withDatabase(adminUrl!, databaseName);
    ownerUrl = withDatabase(adminUrl!, databaseName, { user: owner, password: ownerPassword });
    const journal = JSON.parse(await readFile(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    const staged = await mkdtemp(path.join(tmpdir(), "trestle-owner-migrations-"));
    try {
      await cp(migrationsFolder, staged, { recursive: true });
      // Apply the journal in prefixes so the superuser-only migration runs alone.
      const stops = journal.entries.flatMap((entry, index) => superuserOnly.has(entry.tag) ? [index, index + 1] : []).concat(journal.entries.length).filter((stop) => stop > 0);
      for (const stop of stops) {
        const tag = journal.entries[stop - 1]!.tag;
        const elevated = superuserOnly.has(tag);
        await writeFile(path.join(staged, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, stop) }));
        if (elevated) await maintenance.unsafe(`alter role "${owner}" superuser`);
        const migrator = postgres(ownerUrl, { max: 1, prepare: false, onnotice: () => undefined });
        try {
          const [role] = await migrator<{ rolsuper: boolean; rolbypassrls: boolean }[]>`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
          expect(role, tag).toEqual({ rolsuper: elevated, rolbypassrls: false });
          await migrate(drizzle(migrator), { migrationsFolder: staged });
        } finally {
          await migrator.end();
          if (elevated) await maintenance.unsafe(`alter role "${owner}" nosuperuser`);
        }
      }
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
    admin = postgres(adminDatabaseUrl, { max: 1, prepare: false });
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    if (maintenance) {
      await maintenance.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await maintenance.unsafe(`drop role if exists "${owner}"`);
      await maintenance.end();
    }
  });

  it("gives the owner login no tenant webhook rows and no audit forgery", async () => {
    const a = await seedTenant(tenants.a, 0);
    const b = await seedTenant(tenants.b, 0);
    const runtime = postgres(ownerUrl, { max: 1, prepare: false });
    try {
      for (const table of ["webhook_delivery", "webhook_message", "webhook_endpoint"]) {
        const rows = await runtime.unsafe(`select organization_id from ${table} where organization_id in ($1, $2)`, [a.organizationId, b.organizationId]);
        expect(rows, table).toEqual([]);
      }
      expect(await failure(runtime`insert into webhook_delivery (id, organization_id, message_id, endpoint_id, replay_of_delivery_id, state)
        values (${`${a.organizationId}-forged`}, ${a.organizationId}, ${a.messageId}, ${a.endpointId}, ${a.deliveryId}, 'pending')`)).toMatch(/row-level security/u);
      expect(await runtime`update webhook_delivery set state = 'retry' where id = ${b.deliveryId} returning id`).toEqual([]);
      expect(await failure(runtime`insert into audit_event (name, actor_type, actor_id, organization_id, target_type, target_id, outcome, environment, correlation_id)
        values ('platform.webhook_delivery.replayed', 'platform_operator', 'forged', ${a.organizationId}, 'webhook_delivery', 'forged', 'succeeded', 'local', 'forged')`)).toMatch(/row-level security/u);
      const policies = await runtime<{ policyname: string }[]>`select policyname from pg_policies where policyname like '%replay_owner'`;
      expect(policies).toEqual([]);
    } finally {
      await runtime.end();
    }
  });

  it("keeps platform replay working through the dedicated replay role", async () => {
    const fresh = await seedTenant(`${tenants.a}-fresh`, 0);
    const expired = await seedTenant(`${tenants.a}-expired`, 14 * day + 60_000);
    const platform = createPlatformDatabase(adminDatabaseUrl, "postgres-js");
    const context = { actor: { type: "platform_operator" as const, id: "operator" }, reason: "receiver fixed", environment: "local", correlationId: `owner-${suffix}` };
    const replay = await replayWebhookDelivery(platform, { organizationId: fresh.organizationId, deliveryId: fresh.deliveryId }, context);
    expect(replay.created).toBe(true);
    expect(await replayWebhookDelivery(platform, { organizationId: fresh.organizationId, deliveryId: fresh.deliveryId }, context)).toEqual({ deliveryId: replay.deliveryId, created: false });
    await expect(replayWebhookDelivery(platform, { organizationId: expired.organizationId, deliveryId: expired.deliveryId }, context)).rejects.toThrow("14-day replay window");
    await expect(replayWebhookDelivery(platform, { organizationId: tenants.b, deliveryId: fresh.deliveryId }, context)).rejects.toThrow("does not exist");
    const [created] = await admin!`select state, attempt_count, replay_of_delivery_id, lease_token from webhook_delivery where id = ${replay.deliveryId}`;
    expect(created).toEqual({ state: "pending", attempt_count: 0, replay_of_delivery_id: fresh.deliveryId, lease_token: null });
    const audits = await admin!`select name, organization_id, target_id from audit_event where correlation_id = ${context.correlationId}`;
    expect(audits).toEqual([{ name: "platform.webhook_delivery.replayed", organization_id: fresh.organizationId, target_id: replay.deliveryId }]);
  });

  it("runs the replay function as a NOLOGIN role with only the columns replay reads and writes", async () => {
    const [fn] = await admin!<{ owner: string; definer: boolean; config: string[] | null }[]>`
      select pg_get_userbyid(proowner) as owner, prosecdef as definer, proconfig as config from pg_proc where proname = 'trestle_replay_webhook_delivery'`;
    expect(fn).toEqual({ owner: "trestle_webhook_replay", definer: true, config: ["search_path=pg_catalog, pg_temp"] });
    const [role] = await admin!<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; members: number }[]>`
      select rolcanlogin, rolsuper, rolbypassrls, (select count(*)::int from pg_auth_members m where m.roleid = r.oid and (m.inherit_option or m.set_option)) as members
        from pg_roles r where rolname = 'trestle_webhook_replay'`;
    // The owner keeps only the ADMIN option PostgreSQL gives a role's creator: no INHERIT and no SET.
    expect(role).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, members: 0 });
    const [execute] = await admin!.unsafe<Record<string, boolean>[]>(`select has_function_privilege('trestle_platform', '${replaySignature}', 'EXECUTE') as platform,
      has_function_privilege('trestle_app', '${replaySignature}', 'EXECUTE') as app, has_function_privilege('${owner}', '${replaySignature}', 'EXECUTE') as owner`);
    expect(execute).toEqual({ platform: true, app: false, owner: false });
    const [privileges] = await admin!<Record<string, boolean>[]>`
      select has_column_privilege('trestle_webhook_replay', 'webhook_message', 'envelope', 'SELECT') as envelope,
             has_column_privilege('trestle_webhook_replay', 'outbox_message', 'payload', 'SELECT') as payload,
             has_column_privilege('trestle_webhook_replay', 'webhook_delivery', 'lease_token', 'SELECT') as lease_token,
             has_column_privilege('trestle_webhook_replay', 'webhook_endpoint', 'destination_url', 'SELECT') as destination,
             has_table_privilege('trestle_webhook_replay', 'webhook_delivery', 'DELETE') as delivery_delete,
             has_table_privilege('trestle_webhook_replay', 'audit_event', 'SELECT') as audit_select,
             has_table_privilege('trestle_webhook_replay', 'webhook_secret_version', 'SELECT') as secrets`;
    expect(privileges).toEqual({ envelope: false, payload: false, lease_token: false, destination: false, delivery_delete: false, audit_select: false, secrets: false });
  });
});
