import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { admin, adminDependencies, applyDueSubscriptionChanges, type AdminEnvironment } from "./index.js";
import { platformRoutePolicies, supportRoutePolicies } from "./route-policies.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `adm${Date.now()}`;
const users = { support: `${run}-support`, security: `${run}-security`, billing: `${run}-billing`, none: `${run}-none`, owner: `${run}-owner`, operator: `${run}-operator` };
const org = `${run}-org`;
const plan = `t${run}`;
const environment = { DATABASE_URL: connectionString ?? "", PLATFORM_DATABASE_URL: connectionString ?? "", DATABASE_DRIVER: "postgres-js", BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" } as AdminEnvironment;
let signedIn = users.support;
let sessionAge = 0;
let assuranceLevel: "password" | "mfa" | "phishing_resistant" = "password";

const request = async (method: string, path: string, body?: unknown) => {
  const response = await admin.request(path, { method, headers: { "content-type": "application/json", "x-correlation-id": run }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, environment);
  return { status: response.status, body: (response.status === 204 ? {} : await response.json()) as Record<string, unknown> };
};

suite("platform admin Worker", () => {
  beforeAll(async () => {
    adminDependencies.session = async () => ({ user: { id: signedIn, email: `${signedIn}@example.test`, name: signedIn }, session: { id: `${signedIn}-session`, createdAt: new Date(Date.now() - sessionAge) } });
    adminDependencies.assurance = async (_environment, sessionId) => ({ sessionId, level: assuranceLevel, method: assuranceLevel === "phishing_resistant" ? "passkey" : assuranceLevel === "mfa" ? "totp" : "password", verifiedAt: new Date(Date.now() - sessionAge) });
    for (const id of Object.values(users)) await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, ${id}, ${`${id}@example.test`}, true, now(), now())`;
    await sql!`insert into organization (id, name, slug, created_at) values (${org}, 'Acme', ${org}, now())`;
    await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${org}-m`}, ${org}, ${users.owner}, 'owner', now())`;
    await sql!`insert into platform_role_assignment (user_id, role, granted_by, reason) values (${users.support}, 'support', 'test', 'seed'), (${users.security}, 'security_admin', 'test', 'seed'), (${users.billing}, 'billing_operations', 'test', 'seed'), (${users.owner}, 'support', 'test', 'seed'), (${users.operator}, 'platform_operator', 'test', 'seed')`;
    await sql!`insert into webhook_endpoint (id, organization_id, name, url, url_display, events, secret_ciphertext, secret_fingerprint, created_by) values (${`${run}-hook`}, ${org}, 'CRM', 'https://example.com/crm?key=1', 'https://example.com/crm?…', '{api_key.created}', 'v1:iv:ct', 'feedbeef', 'test')`;
    await sql!`insert into webhook_delivery (id, organization_id, endpoint_id, event_id, event_name, event_version, payload, status, correlation_id) values (${`${run}-failed`}, ${org}, ${`${run}-hook`}, 'evt-1', 'api_key.created', 1, '{}', 'failed', 'c'), (${`${run}-queued`}, ${org}, ${`${run}-hook`}, 'evt-2', 'api_key.created', 1, '{}', 'pending', 'c')`;
    await sql!`insert into notification (id, organization_id, user_id, type, title, body, correlation_id) values (${`${run}-n`}, ${org}, ${users.owner}, 'webhooks.endpoint_failing', 't', 'b', 'c')`;
    await sql!`insert into notification_delivery (id, organization_id, notification_id, user_id, channel, status, preference_source, mandatory, correlation_id) values (${`${run}-email`}, ${org}, ${`${run}-n`}, ${users.owner}, 'email', 'failed', 'default', false, 'c'), (${`${run}-inbox`}, ${org}, ${`${run}-n`}, ${users.owner}, 'in_app', 'pending', 'mandatory', true, 'c')`;
    await sql!`insert into organization_subscription (organization_id, provider, plan, plan_version, status) values (${org}, 'local', 'pro', 'pro@1', 'active')`;
    await sql!`insert into plan_version (plan, version, name, state, entitlements, activated_at) values (${plan}, 1, 'Test plan', 'active', '{"workspace.single": {}}'::jsonb, now())`;
    await sql!`insert into organization_subscription (organization_id, provider, plan, plan_version, status) values (${`${org}-legacy`}, 'local', ${plan}, ${`${plan}@1`}, 'active')`;
    await sql!`insert into service_account (id, organization_id, name, application_roles, created_by) values (${`${run}-sa`}, ${org}, 'bot', '{editor}', 'test')`;
    await sql!`insert into api_key (id, organization_id, service_account_id, environment, display_prefix, verifier, scopes, created_by) values (${`K${String(Date.now()).slice(-14)}x`}, ${org}, ${`${run}-sa`}, 'local', 'tr_dev_x', 'secret-verifier', '{resource.read}', 'test')`;
  });

  beforeEach(() => { signedIn = users.support; sessionAge = 0; assuranceLevel = "password"; });

  afterAll(async () => {
    await sql!`delete from api_key where organization_id = ${org}`;
    await sql!`delete from service_account where organization_id = ${org}`;
    for (const table of ["subscription_override", "organization_entitlement", "organization_subscription", "provider_reconciliation", "subscription_change"]) await sql!.unsafe(`delete from ${table} where organization_id like $1`, [`${org}%`]);
    await sql!`delete from notification where organization_id = ${org}`;
    await sql!`delete from webhook_endpoint where organization_id = ${org}`;
    await sql!`delete from support_session where organization_id = ${org}`;
    await sql!`delete from platform_role_assignment where user_id like ${`${run}%`}`;
    await sql!`delete from billing_provider_mapping where plan = ${plan}`;
    await sql!`delete from plan_version where plan = ${plan}`;
    await sql!`delete from outbox_message where correlation_id = ${run}`;
    await sql!`delete from member where organization_id = ${org}`;
    await sql!`delete from organization where id = ${org}`;
    await sql!`delete from "user" where id like ${`${run}%`}`;
    await sql!.end();
  });

  it("grants nothing to an authenticated user without platform roles", async () => {
    signedIn = users.none;
    expect(await request("GET", "/api/admin/session")).toMatchObject({ status: 403, body: { reason: "no_platform_roles" } });
  });

  it("enforces the exact platform permission for each route", async () => {
    expect((await request("GET", "/api/admin/session")).body).toMatchObject({ roles: ["support"] });
    expect((await request("GET", "/api/admin/organizations?q=Acme")).status).toBe(200);
    expect(await request("POST", "/api/admin/async/dead/x/redrive", { reason: "retry" })).toMatchObject({ status: 403, body: { reason: "permission_missing" } });
    expect((await request("POST", "/api/admin/platform-roles", { userId: users.none, role: "support", reason: "x" })).status).toBe(403);
  });

  it("requires an audit reason and a fresh session to start a support session", async () => {
    const start = (reason: string) => request("POST", "/api/admin/support/sessions", { organizationId: org, profile: "read_only", durationMinutes: 30, reason, ticket: "SUP-42" });
    expect((await start(" ")).status).toBe(422);
    sessionAge = 20 * 60_000;
    expect(await start("support ticket 42")).toMatchObject({ status: 428, body: { error: "step_up_required" } });
    sessionAge = 0;
    expect(await start("support ticket 42")).toMatchObject({ status: 201, body: { session: { organizationId: org, organizationName: "Acme", profile: "read_only", ticket: "SUP-42" } } });
    const [event] = await sql!`select name, reason, organization_id from audit_event where correlation_id = ${run} and name = 'platform.support_session.started'`;
    expect(event).toMatchObject({ reason: "support ticket 42", organization_id: org });
    expect((await request("GET", "/api/admin/session")).body).toMatchObject({ supportSession: { organizationId: org } });
  });

  it("requires MFA, and a passkey to grant authority, outside local development", async () => {
    const staging = { ...environment, APP_ENV: "staging" } as AdminEnvironment;
    const call = async (path: string, body: unknown) => { const response = await admin.request(path, { method: "POST", headers: { "content-type": "application/json", "x-correlation-id": run }, body: JSON.stringify(body) }, staging); return { status: response.status, body: await response.json() as Record<string, unknown> }; };
    signedIn = users.security;
    expect(await call(`/api/admin/users/${users.none}/sessions/revoke`, { reason: "suspicious" })).toMatchObject({ status: 428, body: { error: "step_up_required", required: "mfa", current: "password", reason: "insufficient_level" } });
    assuranceLevel = "mfa";
    expect((await call(`/api/admin/users/${users.none}/sessions/revoke`, { reason: "suspicious" })).status).toBe(200);
    expect(await call("/api/admin/platform-roles", { userId: users.none, role: "support", reason: "on call" })).toMatchObject({ status: 428, body: { required: "phishing_resistant" } });
    assuranceLevel = "phishing_resistant";
    sessionAge = 20 * 60_000;
    expect(await call("/api/admin/platform-roles", { userId: users.none, role: "support", reason: "on call" })).toMatchObject({ status: 428, body: { reason: "stale" } });
    sessionAge = 0;
    expect((await call("/api/admin/platform-roles", { userId: users.none, role: "support", reason: "on call" })).status).toBe(201);
    await sql!`update platform_role_assignment set revoked_at = now(), revoked_by = 'test', revocation_reason = 'cleanup' where user_id = ${users.none} and revoked_at is null`;
  });

  it("grants tenant authority only through the session's support profile", async () => {
    signedIn = users.security;
    expect(await request("GET", "/api/admin/support/tenant/webhooks")).toMatchObject({ status: 403, body: { reason: "permission_missing" } });
    signedIn = users.support;
    const preview = await request("POST", "/api/admin/support/preview", { organizationId: org, profile: "integration_support" });
    expect((preview.body.permissions as Array<{ code: string; allowed: boolean; reason: string }>).find((entry) => entry.code === "organization.webhooks.rotate_secret")).toMatchObject({ allowed: false, reason: /secret/u });
    // The read-only session from the previous test can read but not change endpoints.
    expect(await request("GET", "/api/admin/support/tenant")).toMatchObject({ status: 200, body: { permitted: expect.arrayContaining(["organization.webhooks.read"]) } });
    expect(await request("GET", "/api/admin/support/tenant/webhooks")).toMatchObject({ status: 200, body: { endpoints: [{ id: `${run}-hook`, url: "https://example.com/crm?…" }] } });
    expect(await request("POST", `/api/admin/support/tenant/webhooks/${run}-hook/pause`)).toMatchObject({ status: 403, body: { reason: "permission_missing" } });
    // Switching profiles needs a new explicit session, which replaces the old one.
    expect((await request("POST", "/api/admin/support/sessions", { organizationId: org, profile: "integration_support", durationMinutes: 15, reason: "webhook outage SUP-43" })).status).toBe(201);
    expect((await request("POST", `/api/admin/support/tenant/webhooks/${run}-hook/pause`)).status).toBe(200);
    const [paused] = await sql!`select actor_type, actor_id, reason, support_session_id from audit_event where name = 'webhooks.endpoint.paused' and organization_id = ${org}`;
    const [session] = await sql!`select id from support_session where operator_id = ${users.support} and ended_at is null`;
    expect(paused).toMatchObject({ actor_type: "platform_operator", actor_id: users.support, reason: "webhook outage SUP-43", support_session_id: session!.id });
    expect((await request("POST", `/api/admin/support/tenant/webhooks/${run}-hook/resume`)).status).toBe(200);
    const [replaced] = await sql!`select end_reason from support_session where operator_id = ${users.support} and profile = 'read_only'`;
    expect(replaced).toMatchObject({ end_reason: "replaced" });
    expect((await request("DELETE", "/api/admin/support/sessions/current")).status).toBe(204);
    expect(await request("GET", "/api/admin/support/tenant/webhooks")).toMatchObject({ status: 403, body: { error: "support_session_required" } });
  });

  it("lets security administrators revoke sessions and ends expired ones", async () => {
    expect((await request("POST", "/api/admin/support/sessions", { organizationId: org, profile: "read_only", durationMinutes: 15, reason: "ticket 44" })).status).toBe(201);
    const [active] = await sql!`select id from support_session where operator_id = ${users.support} and ended_at is null`;
    expect(await request("POST", `/api/admin/support/sessions/${active!.id}/revoke`, { reason: "not approved" })).toMatchObject({ status: 403 });
    signedIn = users.security;
    expect((await request("POST", `/api/admin/support/sessions/${active!.id}/revoke`, { reason: "not approved" })).status).toBe(200);
    signedIn = users.support;
    expect((await request("GET", "/api/admin/support/tenant/webhooks")).status).toBe(403);
    expect((await request("POST", "/api/admin/support/sessions", { organizationId: org, profile: "read_only", durationMinutes: 15, reason: "ticket 45" })).status).toBe(201);
    await sql!`update support_session set expires_at = now() - interval '1 second' where operator_id = ${users.support} and ended_at is null`;
    expect(await request("GET", "/api/admin/support/tenant/webhooks")).toMatchObject({ status: 403, body: { error: "support_session_required" } });
    const [expired] = await sql!`select end_reason from support_session where operator_id = ${users.support} and reason = 'ticket 45'`;
    expect(expired).toMatchObject({ end_reason: "expired" });
    const detail = await request("GET", `/api/admin/support/sessions/${active!.id}`);
    expect(detail.body).toMatchObject({ session: { endReason: "revoked", revocationReason: "not approved" } });
  });

  it("separates webhook inspection, emergency disable, and replay permissions", async () => {
    const list = await request("GET", `/api/admin/webhooks?organizationId=${org}`);
    expect(list.body).toMatchObject({ endpoints: [{ id: `${run}-hook`, url: "https://example.com/crm?…", pending: 1 }] });
    expect(JSON.stringify(list.body)).not.toContain("key=1");
    expect((await request("POST", `/api/admin/webhook-deliveries/${run}-failed/replay`, { reason: "customer asked" })).status).toBe(403);
    signedIn = users.operator;
    expect((await request("POST", `/api/admin/webhook-deliveries/${run}-failed/replay`, { reason: "customer asked" })).status).toBe(201);
    expect((await sql!`select 1 from webhook_delivery where replay_of = ${`${run}-failed`}`).length).toBe(1);
    signedIn = users.support;
    expect((await request("POST", `/api/admin/webhooks/${run}-hook/disable`, { reason: "flooding" })).status).toBe(403);
    signedIn = users.security;
    expect((await request("POST", `/api/admin/webhooks/${run}-hook/disable`, { reason: "endpoint flooding a third party" })).status).toBe(200);
    const [endpoint] = await sql!`select state, disabled_by from webhook_endpoint where id = ${`${run}-hook`}`;
    expect(endpoint).toMatchObject({ state: "disabled", disabled_by: `platform:${users.security}` });
    expect((await sql!`select 1 from webhook_delivery where endpoint_id = ${`${run}-hook`} and status = 'pending'`).length).toBe(0);
  });

  it("retries and cancels notification deliveries only as the application allows", async () => {
    const list = await request("GET", `/api/admin/notifications?organizationId=${org}`);
    expect(JSON.stringify(list.body)).not.toMatch(/"title"|"body"/u);
    expect((await request("POST", `/api/admin/notification-deliveries/${run}-email/retry`, { reason: "provider recovered" })).status).toBe(403);
    signedIn = users.operator;
    expect(await request("POST", `/api/admin/notification-deliveries/${run}-inbox/cancel`, { reason: "noise" })).toMatchObject({ status: 409, body: { error: "not_eligible" } });
    expect((await request("POST", `/api/admin/notification-deliveries/${run}-email/retry`, { reason: "provider recovered" })).status).toBe(200);
    const [delivery] = await sql!`select status from notification_delivery where id = ${`${run}-email`}`;
    expect(delivery).toMatchObject({ status: "pending" });
  });

  it("keeps platform, organization, and application authority apart in the access explorer", async () => {
    const response = await request("POST", "/api/admin/access/explain", { organizationId: org, principal: { type: "user", id: users.owner }, permission: "resource.write" });
    expect(response.body).toMatchObject({ decision: { allowed: false, reason: "permission_missing", assignments: { organization: ["owner"], application: [], platform: ["support"] } } });
    expect(String(response.body.explanation)).toMatch(/Organization role\s+owner/u);
    const ownerCanInvite = await request("POST", "/api/admin/access/explain", { organizationId: org, principal: { type: "user", id: users.owner }, permission: "organization.members.invite" });
    expect(ownerCanInvite.body).toMatchObject({ decision: { allowed: true } });
  });

  it("applies audited overrides that recompute effective entitlements without changing the plan", async () => {
    signedIn = users.billing;
    const created = await request("POST", `/api/admin/subscriptions/${org}/overrides`, { code: "team.members", enabled: true, values: { maximum: 40 }, effectiveAt: new Date(Date.now() - 1000).toISOString(), reason: "Negotiated contract" });
    expect(created.status).toBe(201);
    const effective = await request("GET", `/api/admin/entitlements/${org}`);
    expect((effective.body.effective as Array<Record<string, unknown>>).find((entry) => entry.code === "team.members")).toMatchObject({ values: { maximum: 40 }, source: "subscription_override", inheritedFrom: "pro@1" });
    const [plan] = await sql!`select entitlements from plan_version where plan = 'pro' and version = 1`;
    expect((plan!.entitlements as Record<string, unknown>)["team.members"]).toEqual({ maximum: 25 });
    expect((await request("POST", `/api/admin/subscriptions/${org}/overrides`, { code: "team.members", enabled: true, values: { maximum: "lots" }, effectiveAt: new Date().toISOString(), reason: "bad" })).status).toBe(422);
  });

  it("versions plans immutably and refuses to retire a version still in use", async () => {
    signedIn = users.billing;
    const draft = await request("POST", `/api/admin/plans/${plan}/versions`, { reason: "Q4 packaging" });
    expect(draft).toMatchObject({ status: 201, body: { version: 2, state: "draft" } });
    expect((await request("PATCH", `/api/admin/plans/${plan}/versions/1`, { name: "Mutated" })).status).toBe(422);
    expect((await request("PATCH", `/api/admin/plans/${plan}/versions/2`, { entitlements: { "workspace.single": {}, "team.members": { maximum: 30 } } })).status).toBe(200);
    expect((await request("POST", `/api/admin/plans/${plan}/versions/2/transition`, { to: "active", reason: "launch" })).status).toBe(200);
    const versions = (await request("GET", "/api/admin/plans")).body.versions as Array<{ plan: string; version: number; state: string }>;
    expect(versions.filter((version) => version.plan === plan).map((version) => [version.version, version.state])).toEqual([[1, "grandfathered"], [2, "active"]]);
    expect(await request("POST", `/api/admin/plans/${plan}/versions/1/transition`, { to: "retired", reason: "cleanup" })).toMatchObject({ status: 409, body: { error: "in_use" } });
  });

  it("revokes compromised machine credentials and never returns verifiers", async () => {
    signedIn = users.security;
    const keys = await request("GET", `/api/admin/api-keys?organizationId=${org}`);
    expect(JSON.stringify(keys.body)).not.toContain("secret-verifier");
    const [key] = keys.body.apiKeys as Array<{ id: string }>;
    expect((await request("POST", `/api/admin/api-keys/${key!.id}/revoke`, { reason: "leaked" })).status).toBe(200);
    const [row] = await sql!`select revoked_at, revocation_reason from api_key where id = ${key!.id}`;
    expect(row).toMatchObject({ revocation_reason: "leaked" });
    expect(row!.revoked_at).toBeInstanceOf(Date);
  });

  it("applies due scheduled plan changes as an audited system principal", async () => {
    signedIn = users.billing;
    const scheduled = await request("POST", `/api/admin/subscriptions/${org}/changes`, { toPlanVersion: "business@1", effectiveAt: new Date(Date.now() - 1000).toISOString(), reason: "Upgrade at renewal" });
    expect(scheduled.status).toBe(201);
    expect(await applyDueSubscriptionChanges(environment)).toBeGreaterThanOrEqual(1);
    const [subscription] = await sql!`select plan, plan_version from organization_subscription where organization_id = ${org}`;
    expect(subscription).toMatchObject({ plan: "business", plan_version: "business@1" });
    const [entitlement] = await sql!`select inherited_from from organization_entitlement where organization_id = ${org} and entitlement = 'roles.custom'`;
    expect(entitlement?.inherited_from).toBe("business@1");
    const [event] = await sql!`select actor_type, actor_id from audit_event where name = 'commercial.subscription_change.applied' and organization_id = ${org}`;
    expect(event).toMatchObject({ actor_type: "system", actor_id: "system:subscription-scheduler" });
  });

  it("maps plans to Stripe explicitly and verifies each link against Stripe", async () => {
    signedIn = users.billing;
    const original = adminDependencies.stripe;
    // Unconfigured: an existing ID is saved unverified, and creation is refused.
    expect(await request("POST", "/api/admin/billing-mappings", { kind: "product", plan, externalId: `prod_${run}local`, reason: "link" })).toMatchObject({ status: 201, body: { verification: { state: "unverified" } } });
    expect((await request("POST", "/api/admin/billing-mappings/create", { kind: "price", plan, planVersion: 1, unitAmount: 900, currency: "usd", interval: "month", reason: "x" })).status).toBe(409);
    const [unverified] = (await request("GET", `/api/admin/billing-mappings?plan=${plan}`)).body.mappings as Array<{ id: string }>;
    expect((await request("DELETE", `/api/admin/billing-mappings/${unverified!.id}`, { reason: "redo" })).status).toBe(204);

    const objects = new Map<string, { id: string; active: boolean; livemode: boolean; product?: string; interval?: string | null; currency?: string; unitAmount?: number }>([
      [`prod_${run}`, { id: `prod_${run}`, active: true, livemode: false }],
      [`price_${run}other`, { id: `price_${run}other`, active: true, livemode: false, product: "prod_someone_else", interval: "month" }],
      [`price_${run}once`, { id: `price_${run}once`, active: true, livemode: false, product: `prod_${run}`, interval: null }],
    ]);
    adminDependencies.stripe = () => ({
      retrieve: async (_kind, id) => objects.get(id) ?? null,
      createProduct: async () => { throw new Error("unused"); },
      createPrice: async (input) => { const created = { id: `price_${run}new`, active: true, livemode: false, product: input.product, interval: input.interval, currency: input.currency, unitAmount: input.unitAmount }; objects.set(created.id, created); return created; },
    });
    try {
      expect(await request("POST", "/api/admin/billing-mappings", { kind: "price", plan, planVersion: 1, externalId: `price_${run}other`, reason: "x" })).toMatchObject({ status: 422, body: { message: expect.stringMatching(/product first/u) } });
      expect(await request("POST", "/api/admin/billing-mappings", { kind: "product", plan, externalId: `prod_${run}missing`, reason: "x" })).toMatchObject({ status: 422, body: { message: expect.stringMatching(/has no product/u) } });
      expect(await request("POST", "/api/admin/billing-mappings", { kind: "product", plan, externalId: `prod_${run}`, reason: "link product" })).toMatchObject({ status: 201, body: { verification: { state: "verified" } } });
      expect(await request("POST", "/api/admin/billing-mappings", { kind: "price", plan, planVersion: 1, externalId: `price_${run}other`, reason: "x" })).toMatchObject({ status: 422, body: { message: expect.stringMatching(/belongs to prod_someone_else/u) } });
      expect(await request("POST", "/api/admin/billing-mappings", { kind: "price", plan, planVersion: 1, externalId: `price_${run}once`, reason: "x" })).toMatchObject({ status: 422, body: { message: expect.stringMatching(/not recurring/u) } });
      expect(await request("POST", "/api/admin/billing-mappings/create", { kind: "price", plan, planVersion: 1, offer: "monthly", unitAmount: 900, currency: "usd", interval: "month", reason: "price it" })).toMatchObject({ status: 201, body: { externalId: `price_${run}new`, verification: { state: "verified", unitAmount: 900 } } });
      expect((await request("POST", "/api/admin/billing-mappings", { kind: "price", plan, planVersion: 1, offer: "monthly", externalId: `price_${run}once`, reason: "x" })).status).toBe(409);
      expect((await request("POST", "/api/admin/billing-mappings", { kind: "price", plan, planVersion: 9, externalId: `price_${run}once`, reason: "x" })).status).toBe(404);
      const [audit] = await sql!`select count(*)::int as total from audit_event where name in ('commercial.billing_mapping.connected', 'commercial.billing_mapping.created', 'commercial.billing_mapping.disconnected') and correlation_id = ${run}`;
      expect(audit!.total).toBe(4);
    } finally {
      adminDependencies.stripe = original;
    }
  });

  it("versions authentication policy behind safeguards, with activation and rollback", async () => {
    signedIn = users.security;
    await sql!`insert into capability_status (environment, capability_id, label, state, healthy, mode) values ('local', 'email', 'Email', 'configured', true, 'local capture'), ('local', 'passkeys', 'Passkeys', 'configured', true, null), ('local', 'twoFactor', 'Two-factor', 'configured', true, null)
      on conflict (environment, capability_id) do nothing`;
    const before = Number((await sql!`select coalesce(max(version), 0)::int as top from auth_policy_version`)[0]!.top);
    try {
      const initial = await request("GET", "/api/admin/auth-policy");
      expect(initial).toMatchObject({ status: 200, body: { effective: { sources: { "sessions.lifetimeDays": expect.any(String) } } } });
      expect((await request("POST", "/api/admin/auth-policy/drafts", { reason: "tighten sessions" })).status).toBe(201);
      expect((await request("POST", "/api/admin/auth-policy/drafts", { reason: "again" })).status).toBe(409);
      const policy = (initial.body.effective as { policy: Record<string, Record<string, unknown>> }).policy;
      // No guardian has a passkey, so passwordless sign-in is refused at activation.
      const unsafe = { ...policy, signIn: { password: false } };
      expect(await request("PUT", "/api/admin/auth-policy/draft", { policy: unsafe })).toMatchObject({ status: 200, body: { safeguards: [expect.stringMatching(/last viable platform-admin sign-in path/u)] } });
      expect(await request("POST", "/api/admin/auth-policy/draft/activate", { reason: "go" })).toMatchObject({ status: 422, body: { error: "unsafe_policy" } });
      expect((await request("PUT", "/api/admin/auth-policy/draft", { policy: { ...policy, sessions: { ...policy.sessions, maxConcurrent: 50 } } })).status).toBe(200);
      expect(await request("POST", "/api/admin/auth-policy/draft/activate", { reason: "limit sessions" })).toMatchObject({ status: 200, body: { impact: [expect.stringMatching(/at most 50 sessions/u)] } });
      const first = before + 1;
      expect((await request("POST", "/api/admin/auth-policy/drafts", { reason: "longer step-up" })).status).toBe(201);
      await request("PUT", "/api/admin/auth-policy/draft", { policy: { ...policy, sessions: { ...policy.sessions, maxConcurrent: 50 }, stepUp: { windowMinutes: 30 } } });
      expect((await request("POST", "/api/admin/auth-policy/draft/activate", { reason: "step-up" })).status).toBe(200);
      expect(await request("POST", `/api/admin/auth-policy/versions/${first}/rollback`, { reason: "revert step-up" })).toMatchObject({ status: 200, body: { impact: [expect.stringMatching(/last 15 minutes/u)] } });
      const states = await sql!`select version, state, based_on from auth_policy_version where version > ${before} order by version`;
      expect(states.map((row) => `${row.version - before}:${row.state}${row.based_on ? `<${row.based_on - before}` : ""}`)).toEqual(["1:superseded", "2:superseded<1", "3:active<1"]);
      signedIn = users.support;
      expect((await request("GET", "/api/admin/auth-policy")).status).toBe(403);
    } finally {
      await sql!`delete from auth_policy_version where version > ${before}`;
      await sql!`delete from capability_status where environment = 'local' and capability_id in ('email', 'passkeys', 'twoFactor') and reported_at > now() - interval '5 minutes'`;
    }
  });

  it("declares a policy for every admin route", () => {
    const declared = new Set([...platformRoutePolicies, ...supportRoutePolicies].map((policy) => `${policy.method} ${policy.path}`));
    expect(supportRoutePolicies.filter((policy) => policy.revealsSecret)).toEqual([]);
    const registered = admin.routes.filter((route) => route.method !== "ALL" && route.path.startsWith("/api/")).map((route) => `${route.method} ${route.path}`);
    expect(registered.filter((route) => !declared.has(route))).toEqual([]);
    expect([...declared].filter((route) => !registered.includes(route))).toEqual([]);
  });
});
