import { beforeEach, describe, expect, it } from "vitest";

import { adminViews } from "../src/registry.js";
import { admin, adminDependencies, capabilityGuidance, type AdminEnvironment } from "./index.js";
import { adminRoutePolicies } from "./route-policies.js";

const environment: AdminEnvironment = { DATABASE_URL: "postgres://user:password@127.0.0.1:1/unused", DATABASE_DRIVER: "postgres-js", BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" };
const state = { userId: "" as string, roles: [] as string[] };

async function call(method: string, path: string, init: { origin?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { origin: init.origin ?? "http://localhost:42070" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await admin.request(path, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }, environment);
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
}

describe("platform admin Worker", () => {
  beforeEach(() => {
    state.userId = "operator-1";
    state.roles = ["platform_operator"];
    adminDependencies.session = async () => state.userId ? { user: { id: state.userId, email: `${state.userId}@example.test` } } : null;
    adminDependencies.platformRoles = async () => state.roles;
    adminDependencies.operationalStatus = async () => ({ capabilities: { database: { configured: true }, email: { configured: false, mode: "resend" }, billing: { configured: true, mode: "local" }, queues: { configured: false } } });
  });

  it("requires platform sign-in and a platform role; tenant authority grants nothing", async () => {
    state.userId = "";
    expect((await call("GET", "/api/admin/session")).status).toBe(401);
    state.userId = "tenant-owner";
    state.roles = [];
    expect(await call("GET", "/api/admin/session")).toMatchObject({ status: 403, body: { reason: "no_platform_roles" } });
    expect((await call("GET", "/api/admin/overview")).status).toBe(403);
  });

  it("enforces each view's permission and reports only permitted views", async () => {
    state.roles = ["security_admin"];
    const session = await call("GET", "/api/admin/session");
    expect(session.status).toBe(200);
    expect(session.body.permissions).not.toContain("organization.read");
    expect(session.body.views).toEqual(expect.arrayContaining([expect.objectContaining({ id: "overview", allowed: true })]));
    state.roles = ["ghost_role"];
    expect(await call("GET", "/api/admin/session")).toMatchObject({ status: 200, body: { permissions: [] } });
    expect(await call("GET", "/api/admin/health")).toMatchObject({ status: 403, body: { reason: "permission_missing" } });
  });

  it("enforces each action's own permission, the admin origin, and a reason before touching data", async () => {
    const redrive = "/api/admin/operations/outbox/evt-1/redrive";
    state.roles = ["security_admin"];
    expect(await call("POST", redrive, { body: { reason: "ticket" } })).toMatchObject({ status: 403, body: { reason: "permission_missing" } });
    expect(await call("GET", "/api/admin/operations/outbox")).toMatchObject({ status: 403, body: { reason: "permission_missing" } });
    state.roles = ["platform_operator"];
    expect(await call("POST", redrive, { origin: "https://customer.example", body: { reason: "ticket" } })).toMatchObject({ status: 403, body: { reason: "origin_mismatch" } });
    expect(await call("POST", redrive, { body: {} })).toMatchObject({ status: 400, body: { error: "invalid" } });
    const session = await call("GET", "/api/admin/session");
    expect(session.body.permissions).toEqual(expect.arrayContaining(["platform.operations.read", "platform.outbox.redrive", "platform.webhooks.manage"]));
    expect(session.body.permissions.some((code: string) => !code.startsWith("platform."))).toBe(false);
  });

  it("separates commercial authority from operations authority and validates overrides before touching data", async () => {
    const overrides = "/api/admin/commercial/subscriptions/org-1/overrides";
    state.roles = ["platform_operator"];
    expect(await call("GET", "/api/admin/commercial/subscriptions")).toMatchObject({ status: 403, body: { reason: "permission_missing" } });
    expect(await call("POST", overrides, { body: { entitlement: "support.priority", enabled: true, reason: "x" } })).toMatchObject({ status: 403 });
    state.roles = ["commercial_admin"];
    expect(await call("POST", overrides, { body: { entitlement: "not.defined", enabled: true, reason: "x" } })).toMatchObject({ status: 400, body: { error: "invalid" } });
    expect(await call("POST", overrides, { body: { entitlement: "support.priority", reason: "x" } })).toMatchObject({ status: 400 });
    expect(await call("POST", overrides, { body: { entitlement: "support.priority", enabled: true } })).toMatchObject({ status: 400, body: { message: expect.stringContaining("reason") } });
    expect(await call("POST", "/api/admin/operations/outbox/evt-1/redrive", { body: { reason: "x" } })).toMatchObject({ status: 403 });
  });

  it("gives machine-access oversight to security administrators only", async () => {
    state.roles = ["platform_operator"];
    expect((await call("GET", "/api/admin/security/api-keys")).status).toBe(403);
    expect((await call("POST", "/api/admin/security/api-keys/org-1/K000000000000000/revoke", { body: { reason: "leak" } })).status).toBe(403);
    state.roles = ["security_admin"];
    expect(await call("POST", "/api/admin/security/api-keys/org-1/K000000000000000/revoke", { body: {} })).toMatchObject({ status: 400, body: { error: "invalid" } });
  });

  it("requires the support permission and a reason to enter a support session", async () => {
    state.roles = ["commercial_admin"];
    expect((await call("POST", "/api/admin/support/sessions", { body: { organizationId: "org-1", reason: "x" } })).status).toBe(403);
    state.roles = ["platform_operator"];
    expect(await call("POST", "/api/admin/support/sessions", { body: { organizationId: "org-1" } })).toMatchObject({ status: 400, body: { error: "invalid" } });
  });

  it("exposes no sign-up, organization, or unknown admin routes on the admin origin", async () => {
    expect((await call("POST", "/api/auth/sign-up/email")).status).toBe(404);
    expect((await call("POST", "/api/auth/organization/create")).status).toBe(404);
    expect((await call("GET", "/api/admin/not-a-view")).status).toBe(404);
  });

  it("gives sanitized setup guidance for unconfigured capabilities", async () => {
    const guidance = capabilityGuidance({ capabilities: { email: { configured: false, mode: "resend", apiKey: "re_secret" }, queues: { configured: true } } }, "staging");
    expect(guidance.find((capability) => capability.id === "email")).toEqual({ id: "email", label: "Email", state: "not_configured", mode: "resend", repair: "pnpm exec trestle setup --env staging" });
    expect(guidance.find((capability) => capability.id === "queues")).toEqual({ id: "queues", label: "Queues", state: "configured" });
    expect(guidance.find((capability) => capability.id === "workflows")).toMatchObject({ state: "unknown", repair: "pnpm exec trestle setup --env staging" });
    expect(JSON.stringify(guidance)).not.toContain("re_secret");
    expect(capabilityGuidance({ capabilities: { email: { configured: false, mode: "<script>" } } }, "local").find((capability) => capability.id === "email")).not.toHaveProperty("mode");
  });

  it("declares a policy for every route, a route for every policy, and a policy for every view", () => {
    const registered = new Set(admin.routes.filter((route) => route.method !== "ALL").map((route) => `${route.method} ${route.path}`));
    const declared = new Set(adminRoutePolicies.map((policy) => `${policy.method} ${policy.path}`));
    expect([...registered].filter((route) => !declared.has(route)).sort()).toEqual([]);
    expect([...declared].filter((route) => !registered.has(route)).sort()).toEqual([]);
    for (const view of adminViews) for (const route of view.api) {
      expect(adminRoutePolicies.find((policy) => policy.method === route.method && policy.path === route.path)?.permission).toBe(route.permission ?? view.permission);
    }
  });
});
