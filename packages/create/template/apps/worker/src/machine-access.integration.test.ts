import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userId: "", organizationId: "" }));

vi.mock("@__TRESTLE_PROJECT_NAME__/auth", () => ({
  createAuth: () => ({
    handler: vi.fn(),
    api: { getSession: vi.fn(async () => state.userId ? { user: { id: state.userId, email: `${state.userId}@example.test`, name: state.userId }, session: { id: "s", userId: state.userId, activeOrganizationId: state.organizationId } } : null) },
  }),
}));

import { app } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `mach${Date.now()}`;
const orgA = `${run}-a`;
const orgB = `${run}-b`;
const users = { owner: `${run}-owner`, admin: `${run}-appadmin`, outsider: `${run}-outsider` };
const environment = { DATABASE_URL: connectionString ?? "", DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" as const, WEBHOOK_SECRET_KEY: "k".repeat(48) };

async function call(method: string, target: string, options: { body?: unknown; token?: string; tenant?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: "http://localhost:42069" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  else headers["x-trestle-tenant"] = state.organizationId;
  if (options.tenant) headers["x-trestle-tenant"] = options.tenant;
  const response = await app.request(target, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }, environment);
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
}

suite("service accounts and scoped API keys", () => {
  beforeAll(async () => {
    for (const id of Object.values(users)) await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, ${id}, ${`${id}@example.test`}, true, now(), now())`;
    for (const organization of [orgA, orgB]) await sql!`insert into organization (id, name, slug, created_at) values (${organization}, ${organization}, ${organization}, now())`;
    for (const [organization, userId, role] of [[orgA, users.owner, "owner"], [orgA, users.admin, "member"], [orgB, users.outsider, "owner"]] as const) {
      await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${organization}-${userId}`}, ${organization}, ${userId}, ${role}, now())`;
    }
    await sql!`insert into application_role_assignment (organization_id, user_id, role, granted_by) values (${orgA}, ${users.admin}, 'app_admin', 'test'), (${orgB}, ${users.outsider}, 'app_admin', 'test')`;
  });

  beforeEach(() => { state.userId = users.admin; state.organizationId = orgA; });

  afterAll(async () => {
    await sql!`delete from api_key where organization_id like ${`${run}%`}`;
    await sql!`delete from service_account where organization_id like ${`${run}%`}`;
    await sql!`delete from application_role_assignment where organization_id like ${`${run}%`}`;
    await sql!`delete from audit_event where organization_id like ${`${run}%`}`;
    await sql!`delete from member where organization_id like ${`${run}%`}`;
    await sql!`delete from organization where id like ${`${run}%`}`;
    await sql!`delete from "user" where id like ${`${run}%`}`;
    await sql!.end();
  });

  it("keeps service-account management in the application plane", async () => {
    state.userId = users.owner;
    expect(await call("POST", "/api/tenant/service-accounts", { body: { name: "Owner bot", applicationRoles: ["app_admin"] } })).toMatchObject({ status: 403, body: { reason: "permission_missing" } });
    expect((await call("GET", "/api/tenant/service-accounts")).status).toBe(403);
  });

  it("mints a scoped key that works before revocation and fails after, with audited changes", async () => {
    const account = await call("POST", "/api/tenant/service-accounts", { body: { name: "Importer", applicationRoles: ["editor"] } });
    expect(account.status).toBe(201);
    expect(await call("POST", `/api/tenant/service-accounts/${account.body.id}/api-keys`, { body: { name: "wide", scopes: ["resource.read", "application.roles.assign"] } })).toMatchObject({ status: 422 });
    const minted = await call("POST", `/api/tenant/service-accounts/${account.body.id}/api-keys`, { body: { name: "read only", scopes: ["resource.read"] } });
    expect(minted.status).toBe(201);
    expect(minted.body.token).toMatch(/^tr_dev_/u);
    const token = minted.body.token as string;

    // Authorized for resource.read: the artifact simply does not exist.
    expect((await call("GET", "/api/artifacts/missing/access", { token })).status).toBe(404);
    expect(await call("POST", "/api/artifacts", { token, body: { contentType: "text/plain", size: 1 } })).toMatchObject({ status: 403, body: { reason: "scope_missing" } });
    expect((await call("GET", "/api/tenant/access", { token })).status).toBe(403);
    expect((await call("GET", "/api/tenant/service-accounts", { token })).status).toBe(403);
    expect((await call("GET", "/api/artifacts/missing/access", { token, tenant: orgB })).status).toBe(404);

    const listed = await call("GET", "/api/tenant/service-accounts");
    expect(JSON.stringify(listed.body)).not.toContain(token.split("_").at(-1));
    state.userId = users.outsider;
    state.organizationId = orgB;
    expect((await call("POST", `/api/tenant/api-keys/${minted.body.id}/revoke`, { body: { reason: "not mine" } })).status).toBe(404);
    state.userId = users.admin;
    state.organizationId = orgA;

    const rotated = await call("POST", `/api/tenant/api-keys/${minted.body.id}/rotate`, { body: { overlapHours: 0 } });
    expect(rotated.status).toBe(201);
    expect((await call("GET", "/api/artifacts/missing/access", { token: rotated.body.token })).status).toBe(404);
    expect((await call("GET", "/api/artifacts/missing/access", { token })).status).toBe(401);

    expect((await call("POST", `/api/tenant/api-keys/${rotated.body.id}/revoke`, { body: { reason: "integration finished" } })).status).toBe(200);
    expect((await call("GET", "/api/artifacts/missing/access", { token: rotated.body.token })).status).toBe(401);
    expect((await call("POST", `/api/tenant/api-keys/${rotated.body.id}/revoke`, { body: { reason: "again" } })).status).toBe(404);

    const events = await sql!`select name, actor_type, reason, summary from audit_event where organization_id = ${orgA} order by occurred_at`;
    expect(events.map((event) => event.name)).toEqual(["access.service_account.created", "access.api_key.minted", "access.api_key.rotated", "access.api_key.revoked"]);
    expect(JSON.stringify(events)).not.toContain(token.split("_").at(-1));
    expect(events.at(-1)).toMatchObject({ actor_type: "user", reason: "integration finished" });
  });
});
