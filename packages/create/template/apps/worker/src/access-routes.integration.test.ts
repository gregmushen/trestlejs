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
const environment = { DATABASE_URL: connectionString ?? "", DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" as const, WEBHOOK_SECRET_KEY: "k".repeat(48) };

async function call(method: string, target: string, body?: unknown, correlationId?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-trestle-tenant": state.organizationId, origin: "http://localhost:42069" };
  if (correlationId) headers["x-correlation-id"] = correlationId;
  const response = await app.request(target, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, environment);
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
    await sql!`delete from audit_event where organization_id like ${`${run}%`}`;
    await sql!`delete from webhook_subscription where organization_id like ${`${run}%`}`;
    await sql!`delete from webhook_secret_version where organization_id like ${`${run}%`}`.catch(() => undefined);
    await sql!`delete from webhook_endpoint where organization_id like ${`${run}%`}`;
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

  it("records role changes in the same transaction, correlated to the request", async () => {
    state.userId = users.admin;
    const correlationId = `${run}-roles`;
    expect((await call("PUT", `/api/tenant/users/${users.editor}/application-roles`, { roles: ["editor", "reader"] }, correlationId)).status).toBe(200);
    const [event] = await sql!`select name, actor_type, actor_id, target_id, summary, outcome from audit_event where correlation_id = ${correlationId}`;
    expect(event).toMatchObject({ name: "access.application_roles.changed", actor_type: "user", actor_id: users.admin, target_id: users.editor, outcome: "succeeded", summary: { added: ["reader"], removed: [] } });
    const refused = `${run}-refused`;
    expect((await call("PUT", `/api/tenant/users/${users.admin}/application-roles`, { roles: [] }, refused)).status).toBe(409);
    expect(await sql!`select id from audit_event where correlation_id = ${refused}`).toHaveLength(0);
  });

  it("audits webhook endpoint changes without their destination", async () => {
    const endpointId = crypto.randomUUID();
    await sql!`insert into webhook_endpoint (id, organization_id, environment, name, destination_url, state, provider, created_by, updated_by) values (${endpointId}, ${orgA}, 'local', 'CRM', 'https://crm.example.test/hook?token=abc', 'active', 'local', ${users.owner}, ${users.owner})`;
    const correlationId = `${run}-hook`;
    expect(await call("PATCH", `/api/developer/webhooks/endpoints/${endpointId}/state`, { state: "disabled" }, correlationId)).toMatchObject({ status: 200, body: { endpoint: { state: "disabled" } } });
    const [event] = await sql!`select name, actor_id, target_id, summary from audit_event where correlation_id = ${correlationId}`;
    expect(event).toMatchObject({ name: "webhooks.endpoint.state_changed", actor_id: users.owner, target_id: endpointId, summary: { state: "disabled" } });
    expect(JSON.stringify(event)).not.toMatch(/crm\.example|token=abc/u);
  });

  it("shows audit history to organization administrators only, within the tenant", async () => {
    const history = await call("GET", "/api/tenant/audit");
    expect(history.status).toBe(200);
    expect(history.body.events.length).toBeGreaterThan(0);
    expect(history.body.events.map((event: { correlationId: string }) => event.correlationId)).toContain(`${run}-roles`);
    state.userId = users.reader;
    expect((await call("GET", "/api/tenant/audit")).status).toBe(403);
    state.userId = users.outsider;
    state.organizationId = orgB;
    expect((await call("GET", "/api/tenant/audit")).body.events).toEqual([]);
  });
});

