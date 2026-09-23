import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userId: "", organizationId: "" }));

vi.mock("@__TRESTLE_PROJECT_NAME__/auth", () => ({
  createAuth: () => ({
    handler: vi.fn(),
    api: { getSession: vi.fn(async () => state.userId ? { user: { id: state.userId, email: `${state.userId}@example.test`, name: state.userId }, session: { id: "s", userId: state.userId, activeOrganizationId: state.organizationId } } : null) },
  }),
}));

import { customerRoutePolicies } from "@__TRESTLE_PROJECT_NAME__/authz";

import { app } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `acc${Date.now()}`;
const orgA = `${run}-a`;
const orgB = `${run}-b`;
const users = { owner: `${run}-owner`, admin: `${run}-appadmin`, editor: `${run}-editor`, reader: `${run}-reader`, outsider: `${run}-outsider` };
const environment = { DATABASE_URL: connectionString ?? "", DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" as const };

async function call(method: string, target: string, body?: unknown) {
  const response = await app.request(target, { method, headers: { "content-type": "application/json", "x-trestle-tenant": state.organizationId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, environment);
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
}

suite("tenant access routes", () => {
  beforeAll(async () => {
    for (const id of Object.values(users)) await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, ${id}, ${`${id}@example.test`}, true, now(), now())`;
    for (const organization of [orgA, orgB]) await sql!`insert into organization (id, name, slug, created_at) values (${organization}, ${organization}, ${organization}, now())`;
    const members: Array<[string, string, string]> = [[orgA, users.owner, "owner"], [orgA, users.admin, "member"], [orgA, users.editor, "member"], [orgA, users.reader, "member"], [orgB, users.outsider, "owner"]];
    for (const [organization, userId, role] of members) await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${organization}-${userId}`}, ${organization}, ${userId}, ${role}, now())`;
    const grants: Array<[string, string, string]> = [[orgA, users.admin, "app_admin"], [orgA, users.editor, "editor"], [orgA, users.reader, "reader"], [orgB, users.outsider, "app_admin"]];
    for (const [organization, userId, role] of grants) await sql!`insert into application_role_assignment (organization_id, user_id, role, granted_by) values (${organization}, ${userId}, ${role}, 'test')`;
  });

  beforeEach(() => { state.userId = users.owner; state.organizationId = orgA; });

  afterAll(async () => {
    await sql!`delete from application_role_assignment where organization_id like ${`${run}%`}`;
    await sql!`delete from member where organization_id like ${`${run}%`}`;
    await sql!`delete from organization where id like ${`${run}%`}`;
    await sql!`delete from "user" where id like ${`${run}%`}`;
    await sql!.end();
  });

  it("explains each member's own effective access per plane", async () => {
    const owner = await call("GET", "/api/tenant/access");
    expect(owner).toMatchObject({ status: 200, body: { organizationId: orgA, assignments: { organization: ["owner"], application: [] } } });
    expect(owner.body.permissions).toContain("organization.billing.manage");
    expect(owner.body.permissions).not.toContain("resource.read");
    state.userId = users.reader;
    expect((await call("GET", "/api/tenant/access")).body.permissions).toEqual(["organization.billing.read", "organization.members.read", "organization.read", "resource.read"]);
  });

  it("does not let organization ownership reach product resources", async () => {
    expect(await call("POST", "/api/artifacts", "x")).toMatchObject({ status: 403, body: { reason: "permission_missing" } });
    expect((await call("DELETE", `/api/artifacts/${crypto.randomUUID()}`)).status).toBe(403);
    state.userId = users.reader;
    expect((await call("POST", "/api/artifacts", "x")).status).toBe(403);
    state.userId = users.editor;
    // Authorized: the request reaches the handler, which then validates storage and the body.
    expect((await call("POST", "/api/artifacts", "x")).status).not.toBe(403);
  });

  it("keeps organization routes on organization authority only", async () => {
    state.userId = users.admin;
    expect((await call("GET", "/api/developer/webhooks/endpoints")).status).toBe(403);
    expect((await call("POST", "/api/billing/checkout", { plan: "pro", requestId: "r" })).status).toBe(403);
  });

  it("lets only application administrators assign application roles, within the tenant", async () => {
    expect((await call("PUT", `/api/tenant/users/${users.reader}/application-roles`, { roles: ["editor"] })).status).toBe(403);
    state.userId = users.editor;
    expect((await call("GET", "/api/tenant/application-role-assignments")).status).toBe(200);
    expect((await call("PUT", `/api/tenant/users/${users.reader}/application-roles`, { roles: ["editor"] })).status).toBe(403);
    state.userId = users.admin;
    expect(await call("PUT", `/api/tenant/users/${users.reader}/application-roles`, { roles: ["editor", "reader"] })).toMatchObject({ status: 200, body: { added: ["editor"], removed: [] } });
    expect((await call("PUT", `/api/tenant/users/${users.reader}/application-roles`, { roles: ["root"] })).status).toBe(422);
    expect((await call("PUT", `/api/tenant/users/${users.outsider}/application-roles`, { roles: ["editor"] })).status).toBe(404);
    expect(await call("PUT", `/api/tenant/users/${users.admin}/application-roles`, { roles: ["editor"] })).toMatchObject({ status: 409, body: { error: "conflict" } });
    const [outsider] = await sql!`select count(*)::int as count from application_role_assignment where organization_id = ${orgA} and user_id = ${users.outsider}`;
    expect(outsider!.count).toBe(0);
  });

  it("fails closed for another tenant's members and unknown tenants", async () => {
    state.userId = users.outsider;
    expect((await call("GET", "/api/tenant/access")).status).toBe(404);
    state.organizationId = orgB;
    expect((await call("GET", "/api/tenant/application-role-assignments")).body.assignments.map((grant: { userId: string }) => grant.userId)).toEqual([users.outsider]);
  });

  it("declares a policy for every route and a route for every policy", async () => {
    const resourceDirectory = path.resolve(process.cwd(), "../../.trestle/resources");
    const generated = new Set<string>();
    for (const file of (await readdir(resourceDirectory).catch(() => [])).filter((name) => name.endsWith(".json"))) {
      const declaration = JSON.parse(await readFile(path.join(resourceDirectory, file), "utf8")) as { routes?: Array<{ method: string; path: string }> };
      for (const route of declaration.routes ?? []) generated.add(`${route.method.toUpperCase()} ${route.path}`);
    }
    const registered = new Set(app.routes.filter((route) => route.method !== "ALL").map((route) => `${route.method} ${route.path}`));
    const declared = new Set(customerRoutePolicies.map((policy) => `${policy.method} ${policy.path}`));
    expect([...registered].filter((route) => !declared.has(route) && !generated.has(route)).sort()).toEqual([]);
    expect([...declared].filter((route) => !registered.has(route)).sort()).toEqual([]);
  });
});
