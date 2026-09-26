import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlatformDatabase, endSupportSession, mintSupportHandoff, startSupportSession } from "@__TRESTLE_PROJECT_NAME__/db";
import { app } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `supw${Date.now()}`;
const organizationId = `${run}-org`;
const operatorId = `${run}-operator`;
const viewedUserId = `${run}-alice`;
const environment = {
  DATABASE_URL: connectionString!, DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-secret-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:8787", WEB_ORIGIN: "http://localhost:42069", APP_ENV: "local" as const,
};
const action = { actor: { type: "platform_operator" as const, id: operatorId }, reason: "Support ticket 123", environment: "local", correlationId: `${run}-corr` };

suite("customer-app support view", () => {
  beforeAll(async () => {
    await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values
      (${operatorId}, 'Greg', ${`${run}-greg@example.test`}, true, now(), now()),
      (${viewedUserId}, 'Alice', ${`${run}-alice@example.test`}, true, now(), now())`;
    await sql!`insert into organization (id, name, slug, created_at) values (${organizationId}, 'Acme', ${organizationId}, now())`;
    await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${run}-member`}, ${organizationId}, ${viewedUserId}, 'member', now())`;
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

  it("exchanges once without an Alice login, blocks ordinary routes, and ends immediately with the platform session", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    const session = await startSupportSession(platform, { organizationId, targetUserId: viewedUserId, durationMinutes: 30 }, action);
    const handoff = await mintSupportHandoff(platform, session, action);
    const exchange = async (origin: string) => await app.request("http://localhost:8787/api/support/exchange", {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ handoff }),
    }, environment);
    expect((await exchange("https://attacker.example")).status).toBe(403);
    const accepted = await exchange("http://localhost:42069");
    expect(accepted.status).toBe(200);
    const setCookie = accepted.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("trestle_support_view=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).not.toMatch(/better-auth/u);
    const cookie = setCookie.split(";")[0]!;
    expect((await exchange("http://localhost:42069")).status).toBe(403);
    const view = await app.request("http://localhost:8787/api/support/context", { headers: { cookie, "x-trestle-tenant": "some-other-organization" } }, environment);
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({ organization: { id: organizationId }, operator: { id: operatorId }, viewedUser: { id: viewedUserId, name: "Alice" }, readOnly: true });
    for (const [method, path] of [["GET", "/api/billing/subscription"], ["POST", "/api/billing/checkout"], ["GET", "/api/auth/get-session"]] as const) {
      const denied = await app.request(`http://localhost:8787${path}`, { method, headers: { cookie } }, environment);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ error: "support_view_read_only" });
    }
    const exited = await app.request("http://localhost:8787/api/support/exit", { method: "POST", headers: { origin: "http://localhost:42069", cookie } }, environment);
    expect(exited.status).toBe(200);
    expect(exited.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await app.request("http://localhost:8787/api/support/context", { headers: { cookie } }, environment)).status).toBe(401);
    const secondSession = await startSupportSession(platform, { organizationId, targetUserId: viewedUserId, durationMinutes: 30 }, action);
    const again = await mintSupportHandoff(platform, secondSession, action);
    const fresh = await app.request("http://localhost:8787/api/support/exchange", {
      method: "POST", headers: { origin: "http://localhost:42069", "content-type": "application/json" }, body: JSON.stringify({ handoff: again }),
    }, environment);
    const freshCookie = fresh.headers.get("set-cookie")!.split(";")[0]!;
    await endSupportSession(platform, secondSession.id, action);
    expect((await app.request("http://localhost:8787/api/support/context", { headers: { cookie: freshCookie } }, environment)).status).toBe(401);
  });
});
