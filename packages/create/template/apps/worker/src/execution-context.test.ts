import { mintApiKey } from "@__TRESTLE_PROJECT_NAME__/authz";
import type { EffectiveEntitlement } from "@__TRESTLE_PROJECT_NAME__/billing";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ResolvedApiKey } from "./access-dependencies.js";
import { createExecutionContextMiddleware, ExecutionContextError, resolveExecutionContext, type AppVariables, type ContextDependencies } from "./execution-context.js";

const environment = {
  DATABASE_URL: "postgres://user:password@localhost/database",
  DATABASE_DRIVER: "postgres-js" as const,
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters",
  APP_ENV: "production" as const,
};

const session = { user: { id: "user-1", email: "user@example.test" }, session: { activeOrganizationId: "org-a" } };
const now = new Date("2026-09-22T12:00:00Z");
const entitlement = (code: string): EffectiveEntitlement => ({ code, enabled: true, values: {}, source: "plan", inheritedFrom: "business@1", effectiveAt: now.toISOString() });

function dependencies(overrides: Partial<ContextDependencies> = {}): ContextDependencies & { uses: string[] } {
  const uses: string[] = [];
  return {
    uses,
    getSession: async () => session,
    findMembership: async () => ({ role: "owner" }),
    loadApplicationRoles: async () => ["publisher"],
    loadCustomRoles: async () => [],
    loadEntitlements: async () => [entitlement("api.access"), entitlement("workflows.advanced")],
    resolveApiKey: async () => null,
    meteredUsage: async () => 0,
    recordApiKeyUse: async (key, outcome) => { uses.push(`${key.id}:${outcome}`); },
    now: () => now,
    ...overrides,
  };
}

async function machine(overrides: Partial<ResolvedApiKey> = {}) {
  const minted = await mintApiKey("production");
  const key: ResolvedApiKey = {
    id: minted.publicId, organizationId: "org-a", serviceAccountId: "sa-1", environment: "production", scopes: ["resource.read"],
    verifier: minted.verifier, serviceAccountStatus: "active", serviceAccountRoles: ["editor"], rateLimitPerMinute: null, ...overrides,
  };
  return { token: minted.token, key };
}

describe("execution context", () => {
  it("revalidates membership, resolves each authority plane independently, and scopes the database connection", async () => {
    const seen: string[] = [];
    const context = await resolveExecutionContext(new Headers({ "x-correlation-id": "corr-1" }), environment, dependencies({
      findMembership: async (userId, organizationId) => { seen.push(userId, organizationId); return { role: "owner" }; },
    }));
    expect(seen).toEqual(["user-1", "org-a"]);
    expect(context.tenant).toEqual({ organizationId: "org-a", role: "owner" });
    expect(context.access.check({ permission: "organization.members.invite" })).toBe(true);
    expect(context.access.check({ permission: "workflows.publish" })).toBe(true);
    expect(context.access.check({ permission: "application.roles.assign" })).toBe(false);
    expect(context.access.check({ permission: "platform.jobs.read" })).toBe(false);
    expect(context.correlation.correlationId).toBe("corr-1");
  });

  it("does not let an organization Owner without application roles act in the application plane", async () => {
    const context = await resolveExecutionContext(new Headers(), environment, dependencies({ loadApplicationRoles: async () => [] }));
    expect(context.access.check({ permission: "organization.manage" })).toBe(true);
    expect(context.access.explain({ permission: "resource.write" }).reason).toBe("permission_missing");
  });

  it("fails closed for revoked membership", async () => {
    await expect(resolveExecutionContext(new Headers(), environment, dependencies({ findMembership: async () => null }))).rejects.toMatchObject<Partial<ExecutionContextError>>({ code: "not_found", status: 404 });
  });

  it("does not accept a selected tenant without current membership", async () => {
    const selected: string[] = [];
    await expect(resolveExecutionContext(new Headers({ "x-trestle-tenant": "org-b" }), environment, dependencies({
      findMembership: async (_userId, organizationId) => { selected.push(organizationId); return null; },
    }))).rejects.toMatchObject({ code: "not_found" });
    expect(selected).toEqual(["org-b"]);
  });

  it("applies custom application roles only within their tenant", async () => {
    const context = await resolveExecutionContext(new Headers(), environment, dependencies({
      findMembership: async () => ({ role: "member" }),
      loadApplicationRoles: async () => ["auditor"],
      loadCustomRoles: async (organizationId) => organizationId === "org-a" ? [{ key: "auditor", name: "Auditor", permissions: ["resource.read"] }] : [],
    }));
    expect(context.access.explain({ permission: "resource.read" }).permission?.grantedBy).toEqual(["auditor"]);
    expect(context.access.check({ permission: "resource.write" })).toBe(false);
  });

  it("authenticates a service account API key whose scopes reduce its authority", async () => {
    const { token, key } = await machine();
    const deps = dependencies({ resolveApiKey: async (publicId) => publicId === key.id ? key : null });
    const context = await resolveExecutionContext(new Headers({ authorization: `Bearer ${token}` }), environment, deps);
    expect(context.principal).toMatchObject({ kind: "service_account", id: "sa-1", credentialId: key.id });
    expect(context.access.check({ permission: "resource.read" })).toBe(true);
    expect(context.access.explain({ permission: "resource.write" }).reason).toBe("scope_missing");
    expect([...context.permissions]).toEqual(["resource.read"]);
    expect(deps.uses).toEqual([`${key.id}:allowed`]);
  });

  it("rejects forged, revoked, expired, wrong-environment, and suspended keys", async () => {
    const { token, key } = await machine();
    const attempt = (resolved: ResolvedApiKey | null, bearer = token) => resolveExecutionContext(new Headers({ authorization: `Bearer ${bearer}` }), environment, dependencies({ resolveApiKey: async () => resolved }));
    await expect(attempt(null)).rejects.toMatchObject({ status: 401 });
    await expect(attempt(key, `${token.slice(0, -2)}xx`)).rejects.toMatchObject({ status: 401 });
    await expect(attempt({ ...key, revokedAt: now })).rejects.toMatchObject({ status: 401 });
    await expect(attempt({ ...key, expiresAt: new Date(now.getTime() - 1) })).rejects.toMatchObject({ status: 401 });
    await expect(attempt({ ...key, environment: "staging" })).rejects.toMatchObject({ status: 401 });
    await expect(attempt({ ...key, serviceAccountStatus: "suspended" })).rejects.toMatchObject({ status: 401 });
  });

  it("meters API-key requests and refuses them once a hard quota is exhausted", async () => {
    const { token, key } = await machine();
    const requests = (used: number, values: Record<string, unknown>) => dependencies({
      resolveApiKey: async () => key,
      loadEntitlements: async () => [{ ...entitlement("api.requests"), values: values as never }],
      meteredUsage: async (_organizationId, code) => code === "api.requests" ? used : 0,
    });
    const allowed = requests(5, { included: 10, limit: 10, enforcement: "hard", overage: "block" });
    await resolveExecutionContext(new Headers({ authorization: `Bearer ${token}` }), environment, allowed);
    expect(allowed.uses).toEqual([`${key.id}:allowed`]);
    const exhausted = requests(10, { included: 10, limit: 10, enforcement: "hard", overage: "block" });
    await expect(resolveExecutionContext(new Headers({ authorization: `Bearer ${token}` }), environment, exhausted)).rejects.toMatchObject({ code: "quota_exceeded", status: 429 });
    expect(exhausted.uses).toEqual([`${key.id}:denied`]);
    await resolveExecutionContext(new Headers({ authorization: `Bearer ${token}` }), environment, requests(50, { included: 10, limit: null, enforcement: "soft", overage: "bill" }));
  });

  it("never lets an API key select another tenant and enforces its rate limit", async () => {
    const { token, key } = await machine({ rateLimitPerMinute: 1 });
    const deps = dependencies({ resolveApiKey: async () => key });
    await expect(resolveExecutionContext(new Headers({ authorization: `Bearer ${token}`, "x-trestle-tenant": "org-b" }), environment, deps)).rejects.toMatchObject({ code: "not_found" });
    await resolveExecutionContext(new Headers({ authorization: `Bearer ${token}` }), environment, deps);
    await expect(resolveExecutionContext(new Headers({ authorization: `Bearer ${token}` }), environment, deps)).rejects.toMatchObject({ code: "rate_limited", status: 429 });
  });
});

describe("route policy enforcement", () => {
  const app = (deps: ContextDependencies) => {
    const routes = new Hono<{ Variables: AppVariables }>();
    const middleware = createExecutionContextMiddleware(deps);
    routes.get("/api/tenant/members", middleware, (context) => context.json({ ok: context.get("execution").principal.id }));
    routes.put("/api/tenant/members/:memberId/organization-roles", middleware, (context) => context.json({ ok: true }));
    routes.get("/api/articles", middleware, (context) => context.json({ ok: true }));
    routes.post("/api/articles", middleware, (context) => context.json({ ok: true }));
    return routes;
  };

  it("enforces explicit permissions and the default resource policy", async () => {
    const reader = app(dependencies({ findMembership: async () => ({ role: "member" }), loadApplicationRoles: async () => ["reader"] }));
    expect((await reader.request("/api/articles", undefined, environment)).status).toBe(200);
    const denied = await reader.request("/api/articles", { method: "POST" }, environment);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden", reason: "permission_missing" });
    expect((await reader.request("/api/tenant/members/m1/organization-roles", { method: "PUT" }, environment)).status).toBe(403);
    const owner = app(dependencies());
    expect((await owner.request("/api/tenant/members/m1/organization-roles", { method: "PUT" }, environment)).status).toBe(200);
  });

  it("rejects API keys on human-only administration routes even with a broad role", async () => {
    const { token, key } = await machine({ serviceAccountRoles: ["app_admin"], scopes: ["resource.read", "resource.write"] });
    const routes = app(dependencies({ resolveApiKey: async () => key }));
    const headers = { authorization: `Bearer ${token}` };
    expect((await routes.request("/api/tenant/members", { headers }, environment)).status).toBe(403);
    expect((await routes.request("/api/articles", { method: "POST", headers }, environment)).status).toBe(200);
  });
});
