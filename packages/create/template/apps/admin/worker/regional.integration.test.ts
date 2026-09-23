import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { admin, adminDependencies, type AdminEnvironment } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `rgn${Date.now()}`;
const users = { support: `${run}-support`, operator: `${run}-operator`, none: `${run}-none`, owner: `${run}-owner`, sarah: `${run}-sarah`, outsider: `${run}-outsider` };
const org = `${run}-org`;
const environment = { DATABASE_URL: connectionString ?? "", PLATFORM_DATABASE_URL: connectionString ?? "", DATABASE_DRIVER: "postgres-js", BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" } as AdminEnvironment;
let signedIn = users.support;
let sessionAge = 0;

const request = async (method: string, path: string, body?: unknown) => {
  const response = await admin.request(path, { method, headers: { "content-type": "application/json", "x-correlation-id": run }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, environment);
  return { status: response.status, body: (response.status === 204 ? {} : await response.json()) as Record<string, any> };
};

suite("platform admin regional settings", () => {
  beforeAll(async () => {
    adminDependencies.session = async () => ({ user: { id: signedIn, email: `${signedIn}@example.test`, name: signedIn }, session: { id: `${signedIn}-session`, createdAt: new Date(Date.now() - sessionAge) } });
    adminDependencies.assurance = async (_environment, sessionId) => ({ sessionId, level: "password", method: "password", verifiedAt: new Date(Date.now() - sessionAge) });
    for (const id of Object.values(users)) await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, ${id}, ${`${id}@example.test`}, true, now(), now())`;
    await sql!`insert into organization (id, name, slug, created_at) values (${org}, 'Acme', ${org}, now())`;
    await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${org}-o`}, ${org}, ${users.owner}, 'owner', now()), (${`${org}-s`}, ${org}, ${users.sarah}, 'member', now())`;
    await sql!`insert into platform_role_assignment (user_id, role, granted_by, reason) values (${users.support}, 'support', 'test', 'seed'), (${users.operator}, 'platform_operator', 'test', 'seed')`;
    await sql!`insert into organization_regional_settings (organization_id, locale, time_zone, currency, updated_by) values (${org}, 'en-US', 'America/Los_Angeles', 'USD', 'user:test')`;
    await sql!`insert into user_regional_preference (user_id, language, time_zone) values (${users.sarah}, 'en', 'America/New_York')`;
  });

  beforeEach(() => { signedIn = users.support; sessionAge = 0; });

  afterAll(async () => {
    await sql!`delete from support_session where organization_id = ${org}`;
    await sql!`delete from audit_event where organization_id = ${org} or correlation_id = ${run}`;
    await sql!`delete from outbox_message where correlation_id = ${run}`;
    await sql!`delete from organization_regional_settings where organization_id = ${org}`;
    await sql!`delete from user_regional_preference where user_id like ${`${run}%`}`;
    await sql!`delete from platform_role_assignment where user_id like ${`${run}%`}`;
    await sql!`delete from member where organization_id = ${org}`;
    await sql!`delete from organization where id = ${org}`;
    await sql!`delete from "user" where id like ${`${run}%`}`;
    await sql!.end();
  });

  it("shows application defaults, organization defaults, and effective values read-only to an authorized operator", async () => {
    const response = await request("GET", `/api/admin/organizations/${org}/regional`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      application: { language: "en", locale: "en-US", timeZone: "UTC", currency: "USD" },
      configured: { timeZone: "America/Los_Angeles", language: null },
      effective: { timeZone: { value: "America/Los_Angeles", source: "organization" }, language: { value: "en", source: "application" } },
      canRecover: false,
    });
    expect(response.body.members.map((member: { userId: string }) => member.userId).sort()).toEqual([users.owner, users.sarah].sort());
  });

  it("explains a member's effective regional context without mutating anything", async () => {
    const response = await request("GET", `/api/admin/organizations/${org}/regional/resolve?userId=${users.sarah}`);
    expect(response.body).toMatchObject({ user: { userId: users.sarah }, effective: { timeZone: { value: "America/New_York", source: "user" }, locale: { value: "en-US", source: "organization" }, currency: { value: "USD", source: "organization" } } });
    expect((await request("GET", `/api/admin/organizations/${org}/regional/resolve?userId=${users.outsider}`)).status).toBe(404);
  });

  it("denies inspection without the platform permission and mutation without recovery authority", async () => {
    signedIn = users.none;
    expect((await request("GET", `/api/admin/organizations/${org}/regional`)).status).toBe(403);
    signedIn = users.support;
    expect(await request("PUT", `/api/admin/organizations/${org}/regional`, { timeZone: "Europe/Paris", reason: "customer asked" })).toMatchObject({ status: 403, body: { reason: "permission_missing" } });
  });

  it("requires a reason and fresh step-up for platform recovery, then records tenant audit", async () => {
    signedIn = users.operator;
    expect((await request("GET", `/api/admin/organizations/${org}/regional`)).body.canRecover).toBe(true);
    expect(await request("PUT", `/api/admin/organizations/${org}/regional`, { locale: "en-US", timeZone: "Europe/Paris", currency: "USD", reason: " " })).toMatchObject({ status: 422, body: { error: "reason_required" } });
    sessionAge = 20 * 60_000;
    expect(await request("PUT", `/api/admin/organizations/${org}/regional`, { locale: "en-US", timeZone: "Europe/Paris", currency: "USD", reason: "legacy zone repair" })).toMatchObject({ status: 428, body: { error: "step_up_required" } });
    sessionAge = 0;
    expect((await request("PUT", `/api/admin/organizations/${org}/regional`, { locale: "en-US", timeZone: "US/Pacific", currency: "USD", reason: "legacy zone repair" })).status).toBe(422);
    const recovered = await request("PUT", `/api/admin/organizations/${org}/regional`, { locale: "en-US", timeZone: "Europe/Paris", currency: "USD", reason: "legacy zone repair" });
    expect(recovered).toMatchObject({ status: 200, body: { effective: { timeZone: { value: "Europe/Paris", source: "organization" } }, changes: { timeZone: { from: "America/Los_Angeles", to: "Europe/Paris" } } } });
    const [event] = await sql!`select name, actor_type, actor_id, reason, summary from audit_event where organization_id = ${org} and name = 'platform.organization_regional_settings.recovered'`;
    expect(event).toMatchObject({ actor_type: "platform_operator", actor_id: users.operator, reason: "legacy zone repair", summary: { timeZone: { from: "America/Los_Angeles", to: "Europe/Paris" } } });
  });

  it("lets a support session change settings only when its profile carries tenant authority", async () => {
    const start = async (profile: string) => (await request("POST", "/api/admin/support/sessions", { organizationId: org, profile, durationMinutes: 30, reason: "regional ticket", ticket: "SUP-7" })).status;
    expect(await start("read_only")).toBe(201);
    expect((await request("GET", "/api/admin/support/tenant/regional")).status).toBe(200);
    expect(await request("PUT", "/api/admin/support/tenant/regional", { timeZone: "Asia/Tokyo" })).toMatchObject({ status: 403 });
    expect((await request("DELETE", "/api/admin/support/sessions/current")).status).toBeLessThan(300);
    expect(await start("regional_support")).toBe(201);
    const saved = await request("PUT", "/api/admin/support/tenant/regional", { locale: "en-US", timeZone: "Asia/Tokyo", currency: "USD" });
    expect(saved).toMatchObject({ status: 200, body: { effective: { timeZone: { value: "Asia/Tokyo", source: "organization" } } } });
    const [event] = await sql!`select actor_type, support_session_id, reason from audit_event where organization_id = ${org} and name = 'organization.regional_settings.updated' order by occurred_at desc limit 1`;
    expect(event).toMatchObject({ actor_type: "platform_operator", reason: "regional ticket" });
    expect(event!.support_session_id).toBeTruthy();
  });

  it("raises invalid legacy regional configuration under Needs attention", async () => {
    await sql!`insert into organization (id, name, slug, created_at) values (${`${org}-legacy`}, 'Legacy Co', ${`${org}-legacy`}, now())`;
    await sql!`insert into organization_regional_settings (organization_id, time_zone, updated_by) values (${`${org}-legacy`}, 'US/Pacific', 'import')`;
    try {
      const overview = await request("GET", "/api/admin/overview");
      expect(overview.status).toBe(200);
      expect(JSON.stringify(overview.body)).toContain("invalid regional configuration");
    } finally {
      await sql!`delete from organization_regional_settings where organization_id = ${`${org}-legacy`}`;
      await sql!`delete from organization where id = ${`${org}-legacy`}`;
    }
  });
});
