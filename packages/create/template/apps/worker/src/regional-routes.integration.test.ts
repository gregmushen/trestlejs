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

import { app } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `rr${Date.now()}`;
const orgA = `${run}-a`;
const orgB = `${run}-b`;
const owner = `${run}-owner`;
const member = `${run}-member`;
const environment = { DATABASE_URL: connectionString ?? "", DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" as const };

async function call(method: string, path: string, body?: unknown) {
  const response = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, environment);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

suite("regional settings routes", () => {
  beforeAll(async () => {
    for (const id of [owner, member]) await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, ${id}, ${`${id}@example.test`}, true, now(), now())`;
    for (const organization of [orgA, orgB]) await sql!`insert into organization (id, name, slug, created_at) values (${organization}, ${organization}, ${organization}, now())`;
    await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${orgA}-owner`}, ${orgA}, ${owner}, 'owner', now()), (${`${orgA}-member`}, ${orgA}, ${member}, 'member', now()), (${`${orgB}-owner`}, ${orgB}, ${owner}, 'owner', now())`;
  });

  beforeEach(() => { state.userId = owner; state.organizationId = orgA; });

  afterAll(async () => {
    for (const table of ["organization_regional_settings", "audit_event", "outbox_message"]) await sql!.unsafe(`delete from ${table} where ${table === "outbox_message" ? "payload->>'organizationId'" : "organization_id"} like $1`, [`${run}%`]);
    await sql!`delete from user_regional_preference where user_id like ${`${run}%`}`;
    await sql!`delete from member where organization_id like ${`${run}%`}`;
    await sql!`delete from organization where id like ${`${run}%`}`;
    await sql!`delete from "user" where id like ${`${run}%`}`;
    await sql!.end();
  });

  it("shows application defaults with provenance before anything is configured", async () => {
    const response = await call("GET", "/api/tenant/regional");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ configured: { timeZone: null }, effective: { timeZone: { value: "UTC", source: "application" } }, application: { locale: "en-US" }, canManage: true, applicationIssues: [] });
  });

  it("lets an organization administrator save, validates identifiers, and audits the change", async () => {
    const saved = await call("PUT", "/api/tenant/regional", { timeZone: "America/Los_Angeles", locale: "en-US", currency: "USD" });
    expect(saved.status).toBe(200);
    expect(saved.body.effective.timeZone).toEqual({ value: "America/Los_Angeles", source: "organization" });
    expect(saved.body.changes).toEqual({ locale: { from: null, to: "en-US" }, timeZone: { from: null, to: "America/Los_Angeles" }, currency: { from: null, to: "USD" } });
    for (const invalid of [{ timeZone: "US/Pacific" }, { locale: "xx-invalid-locale-tag-!!" }, { currency: "ABC" }, { language: "fr" }]) {
      expect((await call("PUT", "/api/tenant/regional", { timeZone: "America/Los_Angeles", ...invalid })).status).toBe(422);
    }
    const [audit] = await sql!`select name, actor_id, summary from audit_event where organization_id = ${orgA} and name = 'organization.regional_settings.updated'`;
    expect(audit).toMatchObject({ actor_id: owner, summary: { timeZone: { from: null, to: "America/Los_Angeles" } } });
  });

  it("lets members read but not change organization settings", async () => {
    state.userId = member;
    const read = await call("GET", "/api/tenant/regional");
    expect(read.status).toBe(200);
    expect(read.body.canManage).toBe(false);
    expect((await call("PUT", "/api/tenant/regional", { timeZone: "Europe/Paris" })).status).toBe(403);
  });

  it("keeps organizations isolated", async () => {
    state.organizationId = orgB;
    expect((await call("GET", "/api/tenant/regional")).body.effective.timeZone).toEqual({ value: "UTC", source: "application" });
  });

  it("lets any member manage only their own preferences, with provenance against the organization", async () => {
    state.userId = member;
    const saved = await call("PUT", "/api/tenant/regional-preferences", { timeZone: "America/New_York" });
    expect(saved.status).toBe(200);
    expect(saved.body.effective).toMatchObject({ timeZone: { value: "America/New_York", source: "user" }, locale: { value: "en-US", source: "organization" } });
    expect(saved.body.organization.timeZone).toEqual({ value: "America/Los_Angeles", source: "organization" });
    expect((await call("PUT", "/api/tenant/regional-preferences", { currency: "EUR" })).status).toBe(422);
    state.userId = owner;
    expect((await call("GET", "/api/tenant/regional-preferences")).body.effective.timeZone.source).toBe("organization");
  });

  it("previews schedule impact for a proposed zone", async () => {
    const response = await call("GET", "/api/tenant/regional/schedules?timeZone=Europe%2FParis");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ timeZone: "America/Los_Angeles", proposedTimeZone: "Europe/Paris", organizationRelative: [], zoned: [] });
    expect((await call("GET", "/api/tenant/regional/schedules?timeZone=PST")).status).toBe(422);
  });
});
