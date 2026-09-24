import { beforeEach, describe, expect, it } from "vitest";

import { adminViews } from "../src/api-registry.js";
import { admin, adminAuthEnvironment, adminDependencies, capabilityGuidance, type AdminEnvironment } from "./index.js";
import { adminRoutePolicies } from "./route-policies.js";

const environment: AdminEnvironment = { DATABASE_URL: "postgres://user:password@127.0.0.1:1/unused", DATABASE_DRIVER: "postgres-js", BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" };
const state = { userId: "" as string, roles: [] as string[], forwarded: 0 };
type Level = "password" | "mfa" | "phishing_resistant";
const methods = { password: "password", mfa: "totp", phishing_resistant: "passkey" } as const;

/** The signed-in session's recorded evidence, verified `minutesAgo`. */
function assured(level: Level | null, minutesAgo = 0) {
  adminDependencies.assurance = async () => level ? { sessionId: "session-1", userId: state.userId, level, method: methods[level], verifiedAt: new Date(Date.now() - minutesAgo * 60_000) } : null;
}

async function call(method: string, path: string, init: { origin?: string; body?: unknown } = {}, env: AdminEnvironment = environment) {
  const headers: Record<string, string> = { origin: init.origin ?? "http://localhost:42070" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await admin.request(path, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }, env);
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
}

describe("platform admin Worker", () => {
  beforeEach(() => {
    state.userId = "operator-1";
    state.roles = ["platform_operator"];
    adminDependencies.session = async () => state.userId ? { user: { id: state.userId, email: `${state.userId}@example.test` }, session: { id: "session-1" } } : null;
    state.forwarded = 0;
    assured("password");
    adminDependencies.enrolledFactor = async () => null;
    adminDependencies.forwardAuth = async () => { state.forwarded += 1; return new Response(JSON.stringify({ forwarded: true }), { headers: { "content-type": "application/json" } }); };
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

  it("requires fresh assurance for platform actions and reports it in the session", async () => {
    adminDependencies.assurance = async () => ({ sessionId: "session-1", userId: state.userId, level: "password", method: "password", verifiedAt: new Date(Date.now() - 20 * 60_000) });
    const stale = await call("POST", "/api/admin/operations/outbox/evt-1/redrive", { body: { reason: "retry" } });
    expect(stale.status).toBe(428);
    expect(stale.body).toMatchObject({ error: "step_up_required", required: "password", reason: "stale" });

    adminDependencies.assurance = async () => ({ sessionId: "session-1", userId: state.userId, level: "password", method: "password", verifiedAt: new Date() });
    const production = await call("POST", "/api/admin/operations/outbox/evt-1/redrive", { body: { reason: "retry" } }, { ...environment, APP_ENV: "production", DATABASE_ADMIN_URL: environment.DATABASE_URL });
    expect(production.status).toBe(428);
    expect(production.body).toMatchObject({ required: "mfa", reason: "insufficient_level" });

    const session = await call("GET", "/api/admin/session");
    expect(session.body.assurance).toMatchObject({ level: "password", method: "password" });
    expect(Date.parse(session.body.stepUpRequiredAfter)).toBeGreaterThan(Date.now());
  });

  const gatedFactorPaths = [
    ["POST", "/api/auth/two-factor/enable"], ["POST", "/api/auth/two-factor/disable"], ["POST", "/api/auth/two-factor/generate-backup-codes"],
    ["GET", "/api/auth/passkey/generate-register-options"], ["POST", "/api/auth/passkey/verify-registration"], ["POST", "/api/auth/passkey/delete-passkey"],
  ] as const;

  it.each(gatedFactorPaths)("requires fresh evidence at the strongest enrolled factor for %s %s", async (method, path) => {
    const send = async () => await call(method, path, method === "POST" ? { body: {} } : {});
    const cases: Array<{ enrolled: "mfa" | "phishing_resistant" | null; weak: [Level, number]; strong: Level; required: Level; reason: string }> = [
      { enrolled: null, weak: ["password", 20], strong: "password", required: "password", reason: "stale" },
      { enrolled: "mfa", weak: ["password", 0], strong: "mfa", required: "mfa", reason: "insufficient_level" },
      // A phished TOTP code must not add or remove passkeys once the account has one.
      { enrolled: "phishing_resistant", weak: ["mfa", 0], strong: "phishing_resistant", required: "phishing_resistant", reason: "insufficient_level" },
    ];
    for (const { enrolled, weak, strong, required, reason } of cases) {
      adminDependencies.enrolledFactor = async () => enrolled;
      assured(...weak);
      expect(await send()).toMatchObject({ status: 428, body: { error: "step_up_required", required, reason, maxAgeMinutes: 15 } });
      expect(state.forwarded).toBe(0);
      assured(strong);
      expect(await send()).toMatchObject({ status: 200, body: { forwarded: true } });
      state.forwarded = 0;
    }
    assured(null);
    expect(await send()).toMatchObject({ status: 428, body: { reason: "missing" } });
  });

  it("lets an operator with only TOTP add a first passkey with a fresh second factor", async () => {
    adminDependencies.enrolledFactor = async () => "mfa";
    assured("mfa");
    expect(await call("POST", "/api/auth/passkey/verify-registration", { body: {} })).toMatchObject({ status: 200, body: { forwarded: true } });
  });

  it("reads assurance and enrolled factors through one auth database handle", async () => {
    const seen: unknown[] = [];
    adminDependencies.assurance = async (database) => { seen.push(database); return null; };
    adminDependencies.enrolledFactor = async (database) => { seen.push(database); return null; };
    await call("POST", "/api/auth/two-factor/enable", { body: {} });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it("serves factor endpoints only to platform operators, and leaves sign-in challenges open", async () => {
    state.roles = [];
    expect(await call("POST", "/api/auth/two-factor/enable", { body: { password: "x" } })).toMatchObject({ status: 403, body: { reason: "no_platform_roles" } });
    expect(await call("GET", "/api/auth/passkey/generate-register-options")).toMatchObject({ status: 403, body: { reason: "no_platform_roles" } });
    expect(await call("GET", "/api/auth/passkey/list-user-passkeys")).toMatchObject({ status: 403 });
    // Completing enrollment verifies a code on an existing session.
    expect(await call("POST", "/api/auth/two-factor/verify-totp", { body: { code: "000000" } })).toMatchObject({ status: 403 });
    expect(state.forwarded).toBe(0);

    state.roles = ["platform_operator"];
    assured("password", 60);
    expect(await call("GET", "/api/auth/passkey/list-user-passkeys")).toMatchObject({ status: 200, body: { forwarded: true } });
    expect(await call("POST", "/api/auth/two-factor/verify-totp", { body: { code: "000000" } })).toMatchObject({ status: 200, body: { forwarded: true } });

    // A sign-in or step-up challenge has no session yet.
    state.userId = "";
    state.forwarded = 0;
    expect((await call("POST", "/api/auth/two-factor/enable", { body: { password: "x" } })).status).toBe(401);
    for (const [method, path] of [["POST", "/api/auth/two-factor/verify-totp"], ["POST", "/api/auth/two-factor/verify-backup-code"], ["GET", "/api/auth/passkey/generate-authenticate-options"], ["POST", "/api/auth/passkey/verify-authentication"]] as const) {
      expect(await call(method, path, method === "POST" ? { body: {} } : {})).toMatchObject({ status: 200, body: { forwarded: true } });
    }
    expect(state.forwarded).toBe(4);
  });

  it("refuses the seeded local admin's factor changes outside local development", async () => {
    adminDependencies.session = async () => ({ user: { id: "local-admin", email: "admin@trestle.local" }, session: { id: "session-1" } });
    const production = { ...environment, APP_ENV: "production" as const, DATABASE_ADMIN_URL: environment.DATABASE_URL };
    expect(await call("POST", "/api/auth/two-factor/enable", { body: {} }, production)).toMatchObject({ status: 403, body: { reason: "local_account" } });
    expect(await call("POST", "/api/auth/two-factor/enable", { body: {} })).toMatchObject({ status: 200 });
  });

  it("treats an unset APP_ENV as deployed for the local account and the platform connection", async () => {
    const { APP_ENV: _unset, ...unset } = environment;
    adminDependencies.session = async () => ({ user: { id: "local-admin", email: "admin@trestle.local" }, session: { id: "session-1" } });
    const configured = { ...unset, DATABASE_ADMIN_URL: environment.DATABASE_URL };
    expect(await call("GET", "/api/admin/session", {}, configured)).toMatchObject({ status: 403, body: { reason: "local_account" } });
    expect(await call("POST", "/api/auth/two-factor/enable", { body: {} }, configured)).toMatchObject({ status: 403, body: { reason: "local_account" } });
    expect(state.forwarded).toBe(0);

    // Without APP_ENV the admin never falls back to the application's database login.
    adminDependencies.session = async () => ({ user: { id: state.userId, email: `${state.userId}@example.test` }, session: { id: "session-1" } });
    expect(await call("GET", "/api/admin/session", {}, unset)).toMatchObject({ status: 503, body: { error: "not_configured", repair: "pnpm exec trestle setup --env production" } });
  });

  it("checks assurance only where it is needed and fails closed", async () => {
    // Reads never require step-up, and do not look assurance up.
    adminDependencies.assurance = async () => { throw new Error("assurance lookup failed"); };
    expect((await call("GET", "/api/admin/health")).status).toBe(200);
    expect((await call("POST", "/api/admin/operations/outbox/evt-1/redrive", { body: { reason: "retry" } })).status).toBe(500);
    expect((await call("POST", "/api/auth/two-factor/enable", { body: {} })).status).toBe(500);
    expect(state.forwarded).toBe(0);

    assured("password", 60);
    expect((await call("GET", "/api/admin/session")).status).toBe(200);
    assured(null);
    expect(await call("POST", "/api/admin/operations/outbox/evt-1/redrive", { body: { reason: "retry" } })).toMatchObject({ status: 428, body: { reason: "missing" } });
    const session = await call("GET", "/api/admin/session");
    expect(session.body).toMatchObject({ assurance: null, stepUpRequiredAfter: null });

    // Granting authority needs a passkey in every deployed environment.
    state.roles = ["security_admin"];
    assured("mfa");
    const staging = { ...environment, APP_ENV: "staging" as const, DATABASE_ADMIN_URL: environment.DATABASE_URL };
    expect(await call("POST", "/api/admin/platform-roles", { body: { userId: "u-2", role: "platform_operator", reason: "x" } }, staging)).toMatchObject({ status: 428, body: { required: "phishing_resistant" } });

    // An unset APP_ENV is treated as deployed.
    state.roles = ["platform_operator"];
    assured("password");
    const { APP_ENV: _unset, ...unset } = environment;
    expect(await call("POST", "/api/admin/operations/outbox/evt-1/redrive", { body: { reason: "retry" } }, { ...unset, DATABASE_ADMIN_URL: environment.DATABASE_URL })).toMatchObject({ status: 428, body: { required: "mfa" } });
  });

  it("gives Better Auth the admin's fail-closed environment, so security events are never labelled local by default", () => {
    const { APP_ENV: _unset, ...unset } = environment;
    expect(adminAuthEnvironment(unset).APP_ENV).toBe("production");
    expect(adminAuthEnvironment({ ...environment, APP_ENV: "staging" })).toMatchObject({ APP_ENV: "staging", BETTER_AUTH_URL: "http://localhost:8788", WEB_ORIGIN: "http://localhost:42070" });
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
