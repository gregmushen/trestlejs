import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { listAuditEvents, recordAuditEvent } from "./audit.js";
import { createTenantDatabase } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const admin = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `aud${Date.now()}`;
const orgA = `${run}-a`;
const orgB = `${run}-b`;
const tenant = (organizationId: string) => createTenantDatabase(connectionString!, "postgres-js", organizationId);
const event = (organizationId: string | null, name = "access.application_roles.changed") => ({
  name, actor: { type: "user" as const, id: `${run}-actor` }, organizationId, target: { type: "user", id: `${run}-target` },
  summary: { added: ["editor"], apiKey: "tr_live_secret" }, environment: "local", correlationId: `${run}-corr`,
});

/** Drizzle wraps PostgreSQL errors; the RLS or privilege message is on the cause. */
async function rejection(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) { return `${(error as Error).message} ${((error as { cause?: Error }).cause?.message ?? "")}`; }
  return "resolved";
}

async function asApp<T>(organizationId: string, work: (transaction: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return await admin!.begin(async (transaction) => {
    await transaction`set local role trestle_app`;
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
    return await work(transaction);
  }) as T;
}

suite("audit_event", () => {
  afterAll(async () => {
    await admin!`delete from audit_event where correlation_id = ${`${run}-corr`}`;
    await admin!.end();
  });

  it("persists redacted, correlated records readable only by their tenant", async () => {
    await recordAuditEvent(tenant(orgA), event(orgA));
    await recordAuditEvent(tenant(orgB), event(orgB));
    await admin!`insert into audit_event (name, actor_type, actor_id, organization_id, target_type, target_id, outcome, environment, correlation_id) values ('platform.role.granted', 'platform_operator', 'op', null, 'user', 'u', 'succeeded', 'local', ${`${run}-corr`})`;
    const rows = await listAuditEvents(tenant(orgA), orgA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "access.application_roles.changed", actorType: "user", outcome: "succeeded", correlationId: `${run}-corr`, summary: { added: ["editor"], apiKey: "[REDACTED]" } });
    // Even without its own predicate, a tenant sees neither other tenants' nor platform rows.
    const visible = await asApp(orgA, async (transaction) => await transaction`select organization_id from audit_event where correlation_id = ${`${run}-corr`}`);
    expect(visible.map((row) => row.organization_id)).toEqual([orgA]);
  });

  it("is append-only and tenant-bound for the runtime role", async () => {
    await expect(asApp(orgA, async (transaction) => await transaction`update audit_event set outcome = 'failed' where organization_id = ${orgA}`)).rejects.toThrow(/permission denied/u);
    await expect(asApp(orgA, async (transaction) => await transaction`delete from audit_event where organization_id = ${orgA}`)).rejects.toThrow(/permission denied/u);
    expect(await rejection(recordAuditEvent(tenant(orgA), event(orgB)))).toMatch(/row-level security/u);
    expect(await rejection(recordAuditEvent(tenant(orgA), event(null)))).toMatch(/row-level security/u);
  });
});
