import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, createPlatformDatabase, endSupportSession, exchangeSupportHandoff, newSupportToken, outboxApplicationConnectionString, startSupportSession } from "@__TRESTLE_PROJECT_NAME__/db";
import { admin, adminDependencies, type AdminEnvironment } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `supa${Date.now()}`;
const organizationId = `${run}-org`;
const operatorId = `${run}-operator`;
const viewedUserId = `${run}-alice`;
const environment: AdminEnvironment = {
  DATABASE_URL: connectionString!, DATABASE_DRIVER: "postgres-js", BETTER_AUTH_SECRET: "test-secret-at-least-32-characters",
  APP_ENV: "local", ADMIN_ORIGIN: "http://localhost:42070", ADMIN_API_URL: "http://localhost:8788", APP_URL: "http://localhost:42069",
};
const action = { actor: { type: "platform_operator" as const, id: operatorId }, reason: "Customer ticket 123", environment: "local", correlationId: `${run}-corr` };

suite("admin support handoff", () => {
  beforeAll(async () => {
    await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values
      (${operatorId}, 'Greg', ${`${run}-greg@example.test`}, true, now(), now()),
      (${viewedUserId}, 'Alice', ${`${run}-alice@example.test`}, true, now(), now())`;
    await sql!`insert into organization (id, name, slug, created_at) values (${organizationId}, 'Acme', ${organizationId}, now())`;
    await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${run}-member`}, ${organizationId}, ${viewedUserId}, 'member', now())`;
    await sql!`insert into platform_role_assignment (user_id, role, granted_by, reason) values (${operatorId}, 'platform_operator', 'system:test', 'test')`;
    adminDependencies.session = async () => ({ user: { id: operatorId, email: `${run}-greg@example.test` }, session: { id: "test-session" } });
    adminDependencies.platformRoles = async () => ["platform_operator"];
    adminDependencies.assurance = async () => ({ sessionId: "test-session", userId: operatorId, level: "password", method: "password", verifiedAt: new Date() });
    adminDependencies.enrolledFactor = async () => null;
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

  it("requires the operator's own member-bound session and creates a one-time app link", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    const session = await startSupportSession(platform, { organizationId, targetUserId: viewedUserId, durationMinutes: 30 }, action);
    const path = `/api/admin/support/sessions/${session.id}/handoff`;
    const request = async (origin = "http://localhost:42070", env = environment) => await admin.request(`http://localhost:8788${path}`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ reason: "Open customer app" }),
    }, env);
    expect((await request("https://attacker.example")).status).toBe(403);
    expect((await request("http://localhost:42070", { ...environment, APP_URL: "http://untrusted.example" })).status).toBe(503);
    const response = await request();
    expect(response.status).toBe(200);
    const { url } = await response.json() as { url: string };
    const handoffUrl = new URL(url);
    expect(handoffUrl.origin).toBe("http://localhost:42069");
    expect(handoffUrl.pathname).toBe("/support/view");
    expect(handoffUrl.search).toBe("");
    const handoff = new URLSearchParams(handoffUrl.hash.slice(1)).get("handoff")!;
    const app = createDatabase(outboxApplicationConnectionString(connectionString!), "postgres-js");
    expect(await exchangeSupportHandoff(app, handoff, newSupportToken())).toBe(true);
    await endSupportSession(platform, session.id, action);
    expect((await request()).status).toBe(403);
  });
});
