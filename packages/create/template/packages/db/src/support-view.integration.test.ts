import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, createPlatformDatabase } from "./index.js";
import { outboxApplicationConnectionString } from "./outbox.js";
import { activeSupportSession, endSupportSession, startSupportSession } from "./support-sessions.js";
import { activeSupportView, endSupportView, exchangeSupportHandoff, hashSupportToken, mintSupportHandoff, newSupportToken } from "./support-view.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `supv${Date.now()}`;
const organizationId = `${run}-org`;
const operatorId = `${run}-operator`;
const viewedUserId = `${run}-viewed`;
const context = { actor: { type: "platform_operator" as const, id: operatorId }, reason: "Customer ticket 812", environment: "local", correlationId: `${run}-corr` };

suite("read-only support handoff", () => {
  beforeAll(async () => {
    await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values
      (${operatorId}, 'Operator', ${`${run}-operator@example.test`}, true, now(), now()),
      (${viewedUserId}, 'Alice', ${`${run}-alice@example.test`}, true, now(), now())`;
    await sql!`insert into organization (id, name, slug, created_at) values (${organizationId}, 'Acme', ${organizationId}, now())`;
    await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${run}-member`}, ${organizationId}, ${viewedUserId}, 'owner', now())`;
    await sql!`insert into platform_role_assignment (user_id, role, granted_by, reason) values (${operatorId}, 'platform_operator', 'system:test', 'test')`;
  });

  afterAll(async () => {
    await sql!`delete from audit_event where organization_id = ${organizationId}`;
    await sql!`delete from support_view_grant where session_id in (select id from support_session where organization_id = ${organizationId})`;
    await sql!`delete from support_handoff where session_id in (select id from support_session where organization_id = ${organizationId})`;
    await sql!`delete from support_session where organization_id = ${organizationId}`;
    await sql!`delete from platform_role_assignment where user_id = ${operatorId}`;
    await sql!`delete from member where organization_id = ${organizationId}`;
    await sql!`delete from organization where id = ${organizationId}`;
    await sql!`delete from "user" where id in (${operatorId}, ${viewedUserId})`;
    await sql!.end();
  });

  it("exchanges once, keeps actor separate from Alice, audits reads, and fails closed on exit", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    const app = createDatabase(outboxApplicationConnectionString(connectionString!), "postgres-js");
    const session = await startSupportSession(platform, { organizationId, targetUserId: viewedUserId, durationMinutes: 30 }, context);
    const handoff = await mintSupportHandoff(platform, session, context);
    const grant = newSupportToken();
    expect(await exchangeSupportHandoff(app, handoff, grant)).toBe(true);
    expect(await exchangeSupportHandoff(app, handoff, newSupportToken())).toBe(false);
    expect(await activeSupportView(app, grant, { path: "/support/view", correlationId: `${run}-read`, environment: "local" }))
      .toMatchObject({ organizationId, operatorId, viewedUserId, viewedUserName: "Alice" });
    const [audit] = await sql!`select actor_type, actor_id, target_id, support_session_id from audit_event where name = 'platform.support_view.accessed' and organization_id = ${organizationId}`;
    expect(audit).toMatchObject({ actor_type: "platform_operator", actor_id: operatorId, target_id: viewedUserId, support_session_id: session.id });
    expect(await endSupportView(app, grant)).toBe(true);
    expect(await activeSupportSession(platform, session.id, operatorId)).toBeNull();
    expect(await activeSupportView(app, grant, { path: "/support/view", correlationId: `${run}-read`, environment: "local" })).toBeNull();
  });

  it("revoking the operator role or Alice's membership immediately ends the view", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    const app = createDatabase(outboxApplicationConnectionString(connectionString!), "postgres-js");
    const session = await startSupportSession(platform, { organizationId, targetUserId: viewedUserId, durationMinutes: 30 }, context);
    const handoff = await mintSupportHandoff(platform, session, context);
    const grant = newSupportToken();
    expect(await exchangeSupportHandoff(app, handoff, grant)).toBe(true);
    await sql!`update platform_role_assignment set revoked_at = now() where user_id = ${operatorId}`;
    expect(await activeSupportView(app, grant, { path: "/support/view", correlationId: `${run}-read`, environment: "local" })).toBeNull();
    await sql!`update platform_role_assignment set revoked_at = null where user_id = ${operatorId}`;
    await sql!`delete from member where organization_id = ${organizationId}`;
    expect(await activeSupportView(app, grant, { path: "/support/view", correlationId: `${run}-read`, environment: "local" })).toBeNull();
    await endSupportSession(platform, session.id, context);
  });

  it("refuses an expired handoff even while the support session remains active", async () => {
    await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${run}-member-again`}, ${organizationId}, ${viewedUserId}, 'member', now()) on conflict do nothing`;
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    const app = createDatabase(outboxApplicationConnectionString(connectionString!), "postgres-js");
    const session = await startSupportSession(platform, { organizationId, targetUserId: viewedUserId, durationMinutes: 30 }, context);
    const handoff = await mintSupportHandoff(platform, session, context);
    await sql!`update support_handoff set expires_at = now() - interval '1 second' where token_hash = ${await hashSupportToken(handoff)}`;
    expect(await exchangeSupportHandoff(app, handoff, newSupportToken())).toBe(false);
    await endSupportSession(platform, session.id, context);
  });

  it("does not grant the app role direct access to support credentials", async () => {
    await expect(sql!.begin(async (transaction) => {
      await transaction.unsafe("set local role trestle_app");
      await transaction`select token_hash from support_view_grant`;
    })).rejects.toThrow(/permission denied/u);
  });
});
