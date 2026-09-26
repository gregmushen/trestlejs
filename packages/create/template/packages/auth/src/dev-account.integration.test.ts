import { activeApplicationRoles, activePlatformRoles, createDatabase, member, user } from "@__TRESTLE_PROJECT_NAME__/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { DevAccountError, ensureDevAccount } from "./dev-account.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite("development accounts", () => {
  it("creates a verified account once and converges on repeated runs", async () => {
    const email = `dev-${crypto.randomUUID()}@example.test`;
    const slug = `dev-${crypto.randomUUID().slice(0, 8)}`;
    const first = await ensureDevAccount(connectionString!, { email, password: "local-password", organization: { slug, role: "admin" }, applicationRoles: ["editor"], platformRoles: ["platform_operator"] });
    expect(first).toMatchObject({ created: true, passwordSet: true, organizationCreated: true, organizationRole: "admin", applicationRolesGranted: ["editor"], platformRolesGranted: ["platform_operator"] });
    const again = await ensureDevAccount(connectionString!, { email, organization: { slug }, applicationRoles: ["editor", "reader"], platformRoles: ["platform_operator"] });
    expect(again).toMatchObject({ userId: first.userId, created: false, passwordSet: false, organizationId: first.organizationId, organizationCreated: false, applicationRolesGranted: ["reader"], platformRolesGranted: [] });
    const database = createDatabase(connectionString!, "postgres-js");
    expect((await database.select({ verified: user.emailVerified }).from(user).where(eq(user.id, first.userId)))[0]).toEqual({ verified: true });
    expect(await database.select({ role: member.role }).from(member).where(eq(member.userId, first.userId))).toEqual([{ role: "admin" }]);
    expect((await activeApplicationRoles(database, first.organizationId!, first.userId)).sort()).toEqual(["editor", "reader"]);
    expect(await activePlatformRoles(database, first.userId)).toEqual(["platform_operator"]);
  });

  it("refuses unknown roles, missing passwords, and non-local databases", async () => {
    await expect(ensureDevAccount(connectionString!, { email: `new-${crypto.randomUUID()}@example.test` })).rejects.toThrow("supply a password");
    await expect(ensureDevAccount(connectionString!, { email: "x@example.test", password: "p", platformRoles: ["root"] })).rejects.toThrow("unknown platform roles: root");
    await expect(ensureDevAccount(connectionString!, { email: "x@example.test", password: "p", applicationRoles: ["editor"] })).rejects.toThrow("pass --organization");
    await expect(ensureDevAccount("postgres://user:pass@db.example.com/app", { email: "x@example.test", password: "p" })).rejects.toBeInstanceOf(DevAccountError);
  });
});
