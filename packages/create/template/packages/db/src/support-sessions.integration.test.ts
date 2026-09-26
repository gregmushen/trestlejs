import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlatformDatabase } from "./index.js";
import { activeSupportSession, endSupportSession, startSupportSession, supportOrganizationView } from "./support-sessions.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `sup${Date.now()}`;
const organizationId = `${run}-org`;
const operator = `${run}-operator`;
const context = (reason = "customer ticket 812", now?: Date) => ({ actor: { type: "platform_operator" as const, id: operator }, reason, environment: "local", correlationId: `${run}-corr`, ...(now ? { now } : {}) });

async function failure(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) { return `${(error as Error).message} ${((error as { cause?: Error }).cause?.message ?? "")}`; }
  return "resolved";
}

suite("support sessions", () => {
  beforeAll(async () => {
    await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${`${run}-member`}, 'Member', ${`${run}@example.test`}, true, now(), now())`;
    await sql!`insert into organization (id, name, slug, created_at) values (${organizationId}, 'Supported', ${organizationId}, now())`;
    await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${run}-m`}, ${organizationId}, ${`${run}-member`}, 'owner', now())`;
  });

  afterAll(async () => {
    await sql!`delete from audit_event where organization_id = ${organizationId}`;
    await sql!`delete from support_session where organization_id = ${organizationId}`;
    await sql!`delete from member where organization_id = ${organizationId}`;
    await sql!`delete from organization where id = ${organizationId}`;
    await sql!`delete from "user" where id like ${`${run}%`}`;
    await sql!.end();
  });

  it("opens one time-boxed session, audits entry, every view, and exit, and grants nothing after it ends", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    await expect(startSupportSession(platform, { organizationId, durationMinutes: 600 }, context())).rejects.toThrow("between 5 and 240");
    await expect(startSupportSession(platform, { organizationId, durationMinutes: 30 }, context(" "))).rejects.toThrow("reason");
    const session = await startSupportSession(platform, { organizationId, durationMinutes: 30 }, context());
    await expect(startSupportSession(platform, { organizationId, durationMinutes: 30 }, context())).rejects.toThrow("End your open support session");
    expect(await activeSupportSession(platform, session.id, `${run}-someone-else`)).toBeNull();
    const active = await activeSupportSession(platform, session.id, operator);
    const view = await supportOrganizationView(platform, active!, { actor: context().actor, environment: "local", correlationId: `${run}-corr` });
    expect(view.members.map((person) => person.email)).toEqual([`${run}@example.test`]);
    await endSupportSession(platform, session.id, context(""));
    expect(await activeSupportSession(platform, session.id, operator)).toBeNull();
    await expect(endSupportSession(platform, session.id, context(""))).rejects.toThrow("no open support session");
    const events = await sql!`select name, actor_type, support_session_id, reason from audit_event where organization_id = ${organizationId} order by occurred_at`;
    expect(events.map((event) => event.name)).toEqual(["platform.support_session.started", "platform.support_session.accessed", "platform.support_session.ended"]);
    expect(events.every((event) => event.support_session_id === session.id && event.actor_type === "platform_operator")).toBe(true);
    expect(events[0]!.reason).toBe("customer ticket 812");
  });

  it("binds a viewed user to a member of the selected organization", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    await expect(startSupportSession(platform, { organizationId, targetUserId: "outsider", durationMinutes: 30 }, context()))
      .rejects.toThrow("not a member");
    const session = await startSupportSession(platform, { organizationId, targetUserId: `${run}-member`, durationMinutes: 30 }, context());
    expect((await activeSupportSession(platform, session.id, operator))?.targetUserId).toBe(`${run}-member`);
    await endSupportSession(platform, session.id, context(""));
  });

  it("closes an expired session with an audited exit before the operator starts another", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    const past = new Date(Date.now() - 60 * 60_000);
    const stale = await startSupportSession(platform, { organizationId, durationMinutes: 5 }, context("old ticket", past));
    expect(await activeSupportSession(platform, stale.id, operator)).toBeNull();
    const fresh = await startSupportSession(platform, { organizationId, durationMinutes: 5 }, context("new ticket"));
    const [closed] = await sql!`select ended_by from support_session where id = ${stale.id}`;
    expect(closed).toEqual({ ended_by: "system:expired" });
    expect((await sql!`select 1 from audit_event where support_session_id = ${stale.id} and name = 'platform.support_session.ended' and actor_type = 'system'`).length).toBe(1);
    await endSupportSession(platform, fresh.id, context(""));
  });

  it("keeps sessions platform-owned and immutable", async () => {
    const tenant = sql!.begin(async (transaction) => { await transaction.unsafe("set local role trestle_app"); return await transaction`select id from support_session`; });
    expect(await failure(tenant)).toMatch(/permission denied/u);
    const rewrite = sql!.begin(async (transaction) => { await transaction.unsafe("set local role trestle_platform"); return await transaction`update support_session set expires_at = expires_at + interval '1 hour'`; });
    expect(await failure(rewrite)).toMatch(/permission denied/u);
    const remove = sql!.begin(async (transaction) => { await transaction.unsafe("set local role trestle_platform"); return await transaction`delete from support_session`; });
    expect(await failure(remove)).toMatch(/permission denied/u);
  });
});
