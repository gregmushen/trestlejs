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
const run = `reg${Date.now()}`;
const organizationId = `${run}-org`;
const users = { owner: `${run}-owner`, member: `${run}-member` };
const environment = { DATABASE_URL: connectionString ?? "", DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" as const, WEBHOOK_SECRET_KEY: "k".repeat(48) };

async function call(method: string, body?: unknown) {
  const response = await app.request("/api/tenant/regional", { method, headers: { "content-type": "application/json", "x-trestle-tenant": organizationId, origin: "http://localhost:42069" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, environment);
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
}

suite("organization regional settings", () => {
  beforeAll(async () => {
    for (const id of Object.values(users)) await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, ${id}, ${`${id}@example.test`}, true, now(), now())`;
    await sql!`insert into organization (id, name, slug, created_at) values (${organizationId}, ${organizationId}, ${organizationId}, now())`;
    for (const [userId, role] of [[users.owner, "owner"], [users.member, "member"]] as const) await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${run}-${role}`}, ${organizationId}, ${userId}, ${role}, now())`;
  });

  beforeEach(() => { state.userId = users.owner; state.organizationId = organizationId; });

  afterAll(async () => {
    await sql!`delete from audit_event where organization_id = ${organizationId}`;
    await sql!`delete from organization_regional_settings where organization_id = ${organizationId}`;
    await sql!`delete from member where organization_id = ${organizationId}`;
    await sql!`delete from organization where id = ${organizationId}`;
    await sql!`delete from "user" where id like ${`${run}%`}`;
    await sql!.end();
  });

  it("inherits application defaults until the organization overrides them, and audits each change", async () => {
    const initial = await call("GET");
    expect(initial.body.effective.timeZone).toEqual({ value: "UTC", source: "application" });
    expect(await call("PUT", { timeZone: "Mars/Olympus" })).toMatchObject({ status: 422 });
    const changed = await call("PUT", { timeZone: "Europe/Kiev", currency: "eur" });
    expect(changed).toMatchObject({ status: 200, body: { changed: ["timeZone", "currency"], effective: { timeZone: { value: "Europe/Kyiv", source: "organization" }, currency: { value: "EUR", source: "organization" }, locale: { source: "application" } } } });
    expect((await call("PUT", { timeZone: "Europe/Kyiv", currency: "EUR" })).body.changed).toEqual([]);
    const [event] = await sql!`select name, actor_type, summary from audit_event where organization_id = ${organizationId} and name = 'organization.regional_settings.changed'`;
    expect(event).toMatchObject({ actor_type: "user", summary: { timeZone: { from: null, to: "Europe/Kyiv" }, currency: { from: null, to: "EUR" } } });
  });

  it("lets members read but only organization administrators change regional defaults", async () => {
    state.userId = users.member;
    expect((await call("GET")).status).toBe(200);
    expect(await call("PUT", { timeZone: "Asia/Tokyo" })).toMatchObject({ status: 403, body: { reason: "permission_missing" } });
  });
});
