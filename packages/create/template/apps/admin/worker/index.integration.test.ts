import { createAuth } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createDatabase, grantPlatformRole } from "@__TRESTLE_PROJECT_NAME__/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admin, adminDependencies, type AdminEnvironment } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `adm${Date.now()}`;
const operator = `${run}-operator`;
const owner = `${run}-owner`;
const environment: AdminEnvironment = { DATABASE_URL: connectionString ?? "", DATABASE_DRIVER: "postgres-js", BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" };
let signedIn = operator;
const realSession = adminDependencies.session;

suite("platform admin Worker against PostgreSQL", () => {
  beforeAll(async () => {
    adminDependencies.session = async () => ({ user: { id: signedIn, email: `${signedIn}@example.test` } });
    adminDependencies.operationalStatus = async () => ({ capabilities: { database: { configured: true } } });
    for (const id of [operator, owner]) await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, ${id}, ${`${id}@example.test`}, true, now(), now())`;
    await sql!`insert into organization (id, name, slug, created_at) values (${`${run}-org`}, 'Acme', ${`${run}-org`}, now())`;
    await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${run}-m`}, ${`${run}-org`}, ${owner}, 'owner', now())`;
    await grantPlatformRole(createDatabase(connectionString!, "postgres-js"), { userId: operator, role: "platform_operator" }, { actor: { type: "system", id: "test" }, reason: "admin test", environment: "local", correlationId: `${run}-corr` });
  });

  afterAll(async () => {
    await sql!`delete from audit_event where correlation_id = ${`${run}-corr`}`;
    await sql!`delete from member where organization_id = ${`${run}-org`}`;
    await sql!`delete from organization where id = ${`${run}-org`}`;
    await sql!`delete from "user" where id like ${`${run}%`} or email = ${`${run}-signin@example.test`}`;
    await sql!.end();
  });

  it("resolves platform roles and reads the overview on the trestle_platform connection", async () => {
    signedIn = operator;
    const session = await admin.request("/api/admin/session", undefined, environment);
    await expect(session.json()).resolves.toMatchObject({ roles: ["platform_operator"] });
    const overview = await admin.request("/api/admin/overview", undefined, environment);
    expect(overview.status).toBe(200);
    const body = await overview.json() as { organizations: number; operators: number; recentAudit: Array<{ name: string }> };
    expect(body.organizations).toBeGreaterThanOrEqual(1);
    expect(body.operators).toBeGreaterThanOrEqual(1);
    expect(body.recentAudit.map((event) => event.name)).toContain("platform.role.granted");
    const health = await admin.request("/api/admin/health", undefined, environment);
    await expect(health.json()).resolves.toMatchObject({ platformDatabase: { reachable: true } });
  });

  it("redrives a dead outbox event over HTTP and audits it with the request's correlation ID", async () => {
    signedIn = operator;
    const eventId = crypto.randomUUID();
    await sql!`insert into outbox_message (id, event_name, schema_version, occurred_at, resource_type, resource_id, organization_id, correlation_id, idempotency_key, payload, status, attempts, available_at)
      values (${eventId}, 'article.published', 1, now(), 'article', 'a1', ${`${run}-org`}, 'origin-corr', ${`${run}-idem`}, ${sql!.json({})}, 'dead', 5, now())`;
    const listed = await admin.request("/api/admin/operations/outbox?limit=100", undefined, environment);
    expect(((await listed.json()) as { dead: Array<{ id: string }> }).dead.map(({ id }) => id)).toContain(eventId);
    const response = await admin.request(`/api/admin/operations/outbox/${eventId}/redrive`, {
      method: "POST", headers: { origin: "http://localhost:42070", "content-type": "application/json", "x-correlation-id": `${run}-corr` }, body: JSON.stringify({ reason: "consumer fixed" }),
    }, environment);
    expect(response.status).toBe(200);
    expect(await admin.request(`/api/admin/operations/outbox/${eventId}/redrive`, { method: "POST", headers: { origin: "http://localhost:42070", "content-type": "application/json" }, body: JSON.stringify({ reason: "again" }) }, environment)).toHaveProperty("status", 404);
    const [event] = await sql!`select actor_type, actor_id, reason, organization_id from audit_event where correlation_id = ${`${run}-corr`} and name = 'platform.outbox_event.redriven'`;
    expect(event).toEqual({ actor_type: "platform_operator", actor_id: operator, reason: "consumer fixed", organization_id: `${run}-org` });
    await sql!`delete from outbox_message where id = ${eventId}`;
  });

  it("enters and exits a support session over HTTP; tenant reads require the open session", async () => {
    signedIn = operator;
    const post = (path: string, body: unknown) => admin.request(path, { method: "POST", headers: { origin: "http://localhost:42070", "content-type": "application/json", "x-correlation-id": `${run}-corr` }, body: JSON.stringify(body) }, environment);
    const started = await post("/api/admin/support/sessions", { organizationId: `${run}-org`, durationMinutes: 15, reason: "ticket 42" });
    expect(started.status).toBe(201);
    const { id } = await started.json() as { id: string };
    const view = await admin.request(`/api/admin/support/sessions/${id}/organization`, undefined, environment);
    expect(view.status).toBe(200);
    await expect(view.json()).resolves.toMatchObject({ organization: { id: `${run}-org` }, members: [expect.objectContaining({ role: "owner" })] });
    expect((await post(`/api/admin/support/sessions/${id}/end`, {})).status).toBe(200);
    expect(await admin.request(`/api/admin/support/sessions/${id}/organization`, undefined, environment)).toHaveProperty("status", 403);
    const events = await sql!`select name from audit_event where support_session_id = ${id} order by occurred_at`;
    expect(events.map((event) => event.name)).toEqual(["platform.support_session.started", "platform.support_session.accessed", "platform.support_session.ended"]);
    await sql!`delete from audit_event where support_session_id = ${id}`;
    await sql!`delete from support_session where id = ${id}`;
  });

  it("shows recent audit activity on the overview only with platform.audit.read", async () => {
    const commercial = `${run}-commercial`;
    await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${commercial}, ${commercial}, ${`${commercial}@example.test`}, true, now(), now())`;
    await grantPlatformRole(createDatabase(connectionString!, "postgres-js"), { userId: commercial, role: "commercial_admin" }, { actor: { type: "system", id: "test" }, reason: "overview test", environment: "local", correlationId: `${run}-corr` });
    signedIn = commercial;
    const limited = await (await admin.request("/api/admin/overview", undefined, environment)).json() as { organizations: number; recentAudit: unknown[] };
    expect(limited.organizations).toBeGreaterThanOrEqual(1);
    expect(limited.recentAudit).toEqual([]);
    signedIn = operator;
    expect(((await (await admin.request("/api/admin/overview", undefined, environment)).json()) as { recentAudit: unknown[] }).recentAudit.length).toBeGreaterThan(0);
    await sql!`delete from platform_role_assignment where user_id = ${commercial}`;
  });

  it("denies a tenant Owner with no platform role", async () => {
    signedIn = owner;
    const response = await admin.request("/api/admin/overview", undefined, environment);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ reason: "no_platform_roles" });
  });

  it("signs a real account in on the admin origin and requires a platform role", async () => {
    adminDependencies.session = realSession;
    const email = `${run}-signin@example.test`;
    const password = `correct-horse-${run}`;
    await createAuth({ ...environment, EMAIL_DELIVERY_MODE: "local" }).api.signUpEmail({ body: { name: "Signin", email, password } });
    await sql!`update "user" set email_verified = true where email = ${email}`;
    const signIn = await admin.request("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:42070" }, body: JSON.stringify({ email, password }) }, environment);
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const denied = await admin.request("/api/admin/session", { headers: { cookie: cookie! } }, environment);
    expect(denied.status).toBe(403);
    const [account] = await sql!`select id from "user" where email = ${email}`;
    await grantPlatformRole(createDatabase(connectionString!, "postgres-js"), { userId: String(account!.id), role: "security_admin" }, { actor: { type: "system", id: "test" }, reason: "admin sign-in test", environment: "local", correlationId: `${run}-corr` });
    const allowed = await admin.request("/api/admin/session", { headers: { cookie: cookie! } }, environment);
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ roles: ["security_admin"], operator: { email } });
    expect((await admin.request("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x", email: `${run}-new@example.test`, password }) }, environment)).status).toBe(404);
  });
});

