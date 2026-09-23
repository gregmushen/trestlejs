import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userId: "", organizationId: "" }));

vi.mock("@__TRESTLE_PROJECT_NAME__/auth", () => ({
  loadAuthPolicy: vi.fn(async () => ({ policy: {}, version: null, loadedAt: 0 })),
  createAuth: () => ({
    handler: vi.fn(),
    api: { getSession: vi.fn(async () => state.userId ? { user: { id: state.userId, email: `${state.userId}@example.test`, name: state.userId }, session: { id: "s", userId: state.userId, activeOrganizationId: state.organizationId } } : null) },
  }),
}));

import { customerRoutePolicies } from "@__TRESTLE_PROJECT_NAME__/authz";

import { requireExecutionContext } from "./execution-context.js";
import { app } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `tr${Date.now()}`;
const orgA = `${run}-a`;
const orgB = `${run}-b`;
const owner = `${run}-owner`;
const plainOwner = `${run}-plain`;
const environment = { DATABASE_URL: connectionString ?? "", DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" as const };

app.get("/api/probe-resources", requireExecutionContext, (context) => context.json({ principal: context.get("execution").principal.kind, organizationId: context.get("execution").tenant.organizationId }));
app.post("/api/probe-resources", requireExecutionContext, (context) => context.json({ written: true }));

async function call(method: string, path: string, options: { body?: unknown; token?: string; tenant?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.tenant) headers["x-trestle-tenant"] = options.tenant;
  const response = await app.request(path, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }, environment);
  return { status: response.status, body: (response.status === 204 ? {} : await response.json()) as Record<string, unknown> };
}

suite("tenant administration routes", () => {
  beforeAll(async () => {
    for (const id of [owner, plainOwner]) await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, ${id}, ${`${id}@example.test`}, true, now(), now())`;
    for (const organization of [orgA, orgB]) {
      await sql!`insert into organization (id, name, slug, created_at) values (${organization}, ${organization}, ${organization}, now())`;
      await sql!`insert into organization_subscription (organization_id, provider, plan, plan_version, status) values (${organization}, 'local', 'business', 'business@1', 'active')`;
      for (const code of ["api.access", "roles.custom", "workflows.advanced"]) await sql!`insert into organization_entitlement (organization_id, entitlement, values, inherited_from) values (${organization}, ${code}, ${code === "api.access" ? '{"maxKeys": 2}' : "{}"}::text::jsonb, 'business@1')`;
    }
    await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${orgA}-owner`}, ${orgA}, ${owner}, 'owner', now()), (${`${orgA}-plain`}, ${orgA}, ${plainOwner}, 'owner', now()), (${`${orgB}-owner`}, ${orgB}, ${plainOwner}, 'owner', now())`;
    await sql!`insert into application_role_assignment (organization_id, user_id, role, granted_by) values (${orgA}, ${owner}, 'app_admin', 'bootstrap')`;
  });

  beforeEach(() => { state.userId = owner; state.organizationId = orgA; });

  afterAll(async () => {
    for (const table of ["api_key_usage", "api_key", "service_account", "application_role_assignment", "application_role", "organization_entitlement", "organization_subscription", "audit_event"]) await sql!.unsafe(`delete from ${table} where organization_id like $1`, [`${run}%`]);
    await sql!`delete from member where organization_id like ${`${run}%`}`;
    await sql!`delete from organization where id like ${`${run}%`}`;
    await sql!`delete from "user" where id like ${`${run}%`}`;
    await sql!.end();
  });

  it("reports each authority plane and the customer-safe capability document", async () => {
    const access = await call("GET", "/api/tenant/access");
    expect(access.status).toBe(200);
    const permissions = access.body.permissions as string[];
    expect(permissions).toEqual(expect.arrayContaining(["organization.members.invite", "application.roles.assign", "resource.write"]));
    expect(permissions.some((code) => code.startsWith("platform."))).toBe(false);
    expect(JSON.stringify(access.body.capabilities)).not.toMatch(/provider|stripe/iu);
  });

  it("does not let an organization owner without application roles administer the application plane", async () => {
    state.userId = plainOwner;
    expect((await call("GET", "/api/tenant/members")).status).toBe(200);
    expect(await call("POST", "/api/tenant/application-roles", { body: { key: "auditor", name: "Auditor", permissions: ["resource.read"] } })).toMatchObject({ status: 403, body: { reason: "permission_missing" } });
    expect(await call("PUT", `/api/tenant/users/${plainOwner}/application-roles`, { body: { roles: ["app_admin"] } })).toMatchObject({ status: 403 });
  });

  it("never reuses a membership in another tenant", async () => {
    expect((await call("GET", "/api/tenant/members", { tenant: orgB })).status).toBe(404);
  });

  it("mints a one-time key, authenticates it, rotates with overlap, and fails closed after revocation", async () => {
    const account = await call("POST", "/api/tenant/service-accounts", { body: { name: "deploy-bot", applicationRoles: ["editor"] } });
    expect(account.status).toBe(201);
    const serviceAccountId = (account.body.serviceAccount as { id: string }).id;
    expect(await call("POST", `/api/tenant/service-accounts/${serviceAccountId}/keys`, { body: { scopes: ["workflows.publish"] } })).toMatchObject({ status: 422 });
    const minted = await call("POST", `/api/tenant/service-accounts/${serviceAccountId}/keys`, { body: { scopes: ["resource.read"] } });
    expect(minted.status).toBe(201);
    const token = String(minted.body.token);
    const keys = await call("GET", `/api/tenant/service-accounts/${serviceAccountId}/keys`);
    expect(JSON.stringify(keys.body)).not.toContain(token.split("_").at(-1));

    state.userId = "";
    expect(await call("GET", "/api/probe-resources", { token })).toMatchObject({ status: 200, body: { principal: "service_account", organizationId: orgA } });
    expect(await call("POST", "/api/probe-resources", { token })).toMatchObject({ status: 403, body: { reason: "scope_missing" } });
    expect(await call("GET", "/api/tenant/members", { token })).toMatchObject({ status: 403, body: { reason: "principal_type_rejected" } });
    expect((await call("GET", "/api/probe-resources", { token, tenant: orgB })).status).toBe(404);

    state.userId = owner;
    const keyId = (minted.body.key as { id: string }).id;
    const rotated = await call("POST", `/api/tenant/api-keys/${keyId}/rotate`, { body: { overlapHours: 1 } });
    expect(rotated.status).toBe(201);
    expect(await call("POST", `/api/tenant/service-accounts/${serviceAccountId}/keys`, { body: { scopes: ["resource.read"] } })).toMatchObject({ status: 409, body: { error: "limit_exceeded" } });
    state.userId = "";
    expect((await call("GET", "/api/probe-resources", { token })).status).toBe(200);
    expect((await call("GET", "/api/probe-resources", { token: String(rotated.body.token) })).status).toBe(200);

    state.userId = owner;
    expect((await call("POST", `/api/tenant/api-keys/${keyId}/revoke`, { body: { reason: "rotated out" } })).status).toBe(204);
    state.userId = "";
    expect((await call("GET", "/api/probe-resources", { token })).status).toBe(401);
    expect((await call("GET", "/api/probe-resources", { token: `${token.slice(0, -3)}abc` })).status).toBe(401);

    const events = (await sql!`select name from audit_event where organization_id = ${orgA} order by occurred_at`).map((row) => row.name);
    expect(events).toEqual(expect.arrayContaining(["access.service_account.created", "access.api_key.minted", "access.api_key.rotated", "access.api_key.revoked"]));
  });

  it("declares an explicit policy for every non-resource customer route", () => {
    const explicit = new Set(customerRoutePolicies.map((policy) => `${policy.method} ${policy.path}`));
    const registered = [...new Set(app.routes.filter((route) => route.method !== "ALL" && !route.path.startsWith("/api/probe")).map((route) => `${route.method} ${route.path}`))];
    expect(registered.filter((route) => !explicit.has(route))).toEqual([]);
    expect([...explicit].filter((route) => !registered.includes(route))).toEqual([]);
  });
});
