import { createAuth } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createDatabase, grantPlatformRole, recordDeclaredJobRuntime } from "@__TRESTLE_PROJECT_NAME__/db";
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
const realAssurance = adminDependencies.assurance;

suite("platform admin Worker against PostgreSQL", () => {
  beforeAll(async () => {
    adminDependencies.session = async () => ({ user: { id: signedIn, email: `${signedIn}@example.test` }, session: { id: `${signedIn}-session` } });
    adminDependencies.assurance = async () => ({ sessionId: `${signedIn}-session`, userId: signedIn, level: "password", method: "password", verifiedAt: new Date() });
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
    adminDependencies.assurance = realAssurance;
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
    // The sign-in recorded its own evidence, which the session reports for step-up.
    await expect(allowed.json()).resolves.toMatchObject({ roles: ["security_admin"], operator: { email }, assurance: { level: "password", method: "password" } });
    // A fresh password starts the first enrollment; once a passkey exists, this password session is below the minimum sign-in level.
    const enable = () => admin.request("/api/auth/two-factor/enable", { method: "POST", headers: { cookie: cookie!, "content-type": "application/json", origin: "http://localhost:42070" }, body: JSON.stringify({ password }) }, environment);
    expect((await enable()).status).toBe(200);
    await sql!`insert into passkey (id, user_id, public_key, credential_id, counter, device_type, backed_up) values (${`${run}-pk`}, ${String(account!.id)}, 'key', ${`${run}-cred`}, 0, 'singleDevice', false)`;
    await expect((await enable()).json()).resolves.toMatchObject({ error: "step_up_required", required: "mfa", scope: "session" });
    expect((await admin.request("/api/admin/session", { headers: { cookie: cookie! } }, environment)).status).toBe(428);
    expect((await admin.request("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x", email: `${run}-new@example.test`, password }) }, environment)).status).toBe(404);
  });

  it("reads the declared jobs engine and outbox dispatch health on the trestle_platform connection", async () => {
    signedIn = operator;
    // The sign-in test above restores the real session lookup.
    adminDependencies.session = async () => ({ user: { id: signedIn, email: `${signedIn}@example.test` }, session: { id: `${signedIn}-session` } });
    adminDependencies.assurance = async () => ({ sessionId: `${signedIn}-session`, userId: signedIn, level: "password", method: "password", verifiedAt: new Date() });
    try {
      await sql!`delete from job_runtime_config where environment = 'local'`;
      expect(await (await admin.request("/api/admin/operations/jobs", undefined, environment)).json()).toMatchObject({ runtime: null, source: "unknown" });
      await recordDeclaredJobRuntime(connectionString!, "local", { runtime: "inngest", hosting: "self-hosted", endpoint: "https://inngest.example.test", project: null });
      const eventId = crypto.randomUUID();
      await sql!`insert into outbox_message (id, event_name, schema_version, occurred_at, resource_type, resource_id, organization_id, correlation_id, idempotency_key, payload, status, attempts, available_at)
        values (${eventId}, 'article.published', 1, now(), 'article', 'a1', ${`${run}-org`}, 'jobs-corr', ${`${run}-jobs`}, ${sql!.json({})}, 'pending', 0, now())`;
      const response = await admin.request("/api/admin/operations/jobs", undefined, environment);
      expect(response.status).toBe(200);
      const body = await response.json() as { dispatch: { pending: number } };
      expect(body).toMatchObject({ runtime: "inngest", hosting: "self-hosted", endpoint: "https://inngest.example.test/", source: "declared", supportStatus: "experimental", dashboardUrl: "https://inngest.example.test/", migration: null });
      expect(body.dispatch.pending).toBeGreaterThanOrEqual(1);
    } finally {
      await sql!`delete from outbox_message where idempotency_key = ${`${run}-jobs`}`;
      await sql!`delete from job_runtime_config where environment = 'local'`;
    }
  });

  it("plans, switches, reverts, and settles the jobs engine over HTTP with audit and no secrets", async () => {
    signedIn = operator;
    adminDependencies.session = async () => ({ user: { id: signedIn, email: `${signedIn}@example.test` }, session: { id: `${signedIn}-session` } });
    adminDependencies.assurance = async () => ({ sessionId: `${signedIn}-session`, userId: signedIn, level: "password", method: "password", verifiedAt: new Date() });
    const send = async (method: string, path: string, body: unknown) => {
      const response = await admin.request(`/api/admin/operations/jobs${path}`, { method, headers: { origin: "http://localhost:42070", "content-type": "application/json", "x-correlation-id": `${run}-jobs-corr` }, body: JSON.stringify(body) }, environment);
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    try {
      await sql!`delete from job_runtime_config where environment = 'local'`;
      await recordDeclaredJobRuntime(connectionString!, "local", { runtime: "cloudflare", hosting: "cloudflare", endpoint: null, project: null, available: ["cloudflare", "inngest", "trigger"], credentials: { TRIGGER_SECRET_KEY: true, INNGEST_EVENT_KEY: false, INNGEST_SIGNING_KEY: false } });
      const plan = await send("POST", "/plan", { runtime: "trigger", hosting: "cloud", project: "proj_abc" });
      expect(plan).toMatchObject({ status: 200, body: { kind: "switch", allowed: true, experimental: true, overrideVersion: 0, credentials: [{ name: "TRIGGER_SECRET_KEY", present: true }, { name: "RESEND_API_KEY", present: false }] } });
      expect((await send("POST", "/plan", { runtime: "inngest", hosting: "cloud" })).body.problems.map((problem: { code: string }) => problem.code)).toEqual(["credentials_missing"]);
      expect(await send("PUT", "", { runtime: "inngest", hosting: "cloud", expectedVersion: 0, acknowledgeExperimental: true, reason: "try inngest" })).toMatchObject({ status: 422, body: { codes: ["credentials_missing"] } });
      expect(await send("PUT", "", { runtime: "trigger", hosting: "cloud", project: "proj_abc", expectedVersion: 0, reason: "no ack" })).toMatchObject({ status: 422, body: { codes: ["experimental_not_acknowledged"] } });
      expect(await send("PUT", "", { runtime: "trigger", hosting: "cloud", project: "proj_abc", expectedVersion: 0, acknowledgeExperimental: true, reason: "move heavy jobs" })).toMatchObject({ status: 200, body: { overrideVersion: 1 } });
      expect(await send("PUT", "", { runtime: "trigger", hosting: "cloud", project: "proj_abc", expectedVersion: 0, acknowledgeExperimental: true, reason: "stale" })).toMatchObject({ status: 409 });
      const status = await (await admin.request("/api/admin/operations/jobs", undefined, environment)).json() as Record<string, any>;
      expect(status).toMatchObject({ runtime: "trigger", source: "override", overrideVersion: 1, override: { runtime: "trigger", by: operator }, declared: { runtime: "cloudflare" }, available: ["cloudflare", "inngest", "trigger"] });
      expect(await send("PUT", "/settings", { dispatchPaused: true, expectedVersion: 1, reason: "incident" })).toMatchObject({ status: 200, body: { overrideVersion: 2 } });
      expect(await send("DELETE", "/override", { expectedVersion: 2, reason: "back to deploy" })).toMatchObject({ status: 200, body: { overrideVersion: 3 } });
      expect(await send("POST", "/settle", { olderThanMinutes: 20_000, reason: "drain trigger" })).toMatchObject({ status: 200, body: { deadLettered: expect.any(Number), requeued: expect.any(Number) } });
      const events = await sql!<{ name: string; actor_id: string; reason: string; summary: unknown }[]>`select name, actor_id, reason, summary from audit_event where correlation_id = ${`${run}-jobs-corr`} order by occurred_at`;
      expect(events.map((event) => [event.name, event.actor_id, event.reason])).toEqual([
        ["platform.job_runtime.overridden", operator, "move heavy jobs"], ["platform.job_dispatch.paused", operator, "incident"],
        ["platform.job_runtime.override_cleared", operator, "back to deploy"], ["platform.job_dispatch.settled", operator, "drain trigger"],
      ]);
      expect(JSON.stringify(events)).not.toMatch(/SECRET_KEY|EVENT_KEY|credentials/u);
    } finally {
      await sql!`delete from job_runtime_config where environment = 'local'`;
    }
  });

  it("lists, filters, and removes an email suppression over HTTP with an audit row; the platform role cannot add one", async () => {
    signedIn = operator;
    const organizationId = `${run}-org`;
    const eventId = `msg_${run}`;
    try {
      await sql!`insert into email_suppression (organization_id, address, reason, source_event_id) values (${organizationId}, ${`${run}@example.test`}, 'complained', ${eventId}), (${organizationId}, ${`${run}-other@example.test`}, 'bounced', null)`;
      await sql!`insert into email_delivery_event (id, email_delivery_id, status, occurred_at, organization_id, bounce_type, bounce_sub_type) values (${eventId}, ${`email_${run}`}, 'complained', now(), ${organizationId}, null, null)`;
      const read = await admin.request("/api/admin/email", undefined, environment);
      expect(read.status).toBe(200);
      const email = await read.json() as { counts: { last24h: { complained: number } }; events: Array<{ id: string; organizationId: string | null }>; webhook: { lastReceivedAt: string | null } };
      expect(email.counts.last24h.complained).toBeGreaterThanOrEqual(1);
      expect(email.events.find((event) => event.id === eventId)).toMatchObject({ organizationId });
      expect(email.webhook.lastReceivedAt).not.toBeNull();
      const listed = await (await admin.request(`/api/admin/email/suppressions?organizationId=${organizationId}`, undefined, environment)).json() as { suppressions: Array<{ address: string; reason: string; organizationName: string | null }> };
      expect(listed.suppressions).toHaveLength(2);
      expect(listed.suppressions.every((row) => !row.address.includes(run) && row.organizationName === "Acme")).toBe(true);
      const found = await (await admin.request(`/api/admin/email/suppressions?address=${encodeURIComponent(`${run.toUpperCase()}@Example.test`)}`, undefined, environment)).json() as { suppressions: Array<{ reason: string; sourceEventId: string }> };
      expect(found.suppressions).toEqual([expect.objectContaining({ reason: "complained", sourceEventId: eventId })]);
      const remove = (reason: string) => admin.request("/api/admin/email/suppressions", { method: "DELETE", headers: { origin: "http://localhost:42070", "content-type": "application/json", "x-correlation-id": `${run}-corr` },
        body: JSON.stringify({ organizationId, address: `${run}@example.test`, reason }) }, environment);
      expect((await remove("recipient re-subscribed in ticket 7")).status).toBe(200);
      expect((await remove("again")).status).toBe(404);
      expect(await sql!`select address from email_suppression where organization_id = ${organizationId}`).toEqual([{ address: `${run}-other@example.test` }]);
      const [audit] = await sql!`select actor_id, organization_id, target_type, target_id, reason, summary from audit_event where correlation_id = ${`${run}-corr`} and name = 'platform.email_suppression.removed'`;
      expect(audit).toMatchObject({ actor_id: operator, organization_id: organizationId, target_type: "email_suppression", reason: "recipient re-subscribed in ticket 7", summary: { suppressionReason: "complained", sourceEventId: eventId } });
      expect(JSON.stringify(audit)).not.toContain(`${run}@example.test`);
      // The platform role reads and removes; it never adds or rewrites a suppression.
      await expect(sql!.begin(async (transaction) => {
        await transaction`set local role trestle_platform`;
        await transaction`insert into email_suppression (organization_id, address, reason) values (${organizationId}, 'forged@example.test', 'unsubscribed')`;
      })).rejects.toThrow(/permission denied|row-level security/u);
    } finally {
      await sql!`delete from email_suppression where organization_id = ${organizationId}`;
      await sql!`delete from email_delivery_event where id = ${eventId}`;
    }
  });
});

