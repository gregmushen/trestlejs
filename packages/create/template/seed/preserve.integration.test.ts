import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { ensureDevAccount } from "../packages/auth/src/dev-account.js";
import { createDatabase, member, tenantRecord, user } from "../packages/db/src/index.js";
import { applySeedScenario } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite("seed lifecycle", () => {
  it("seeds additively, preserving development accounts and application data", async () => {
    const email = `keep-${crypto.randomUUID()}@example.test`;
    const slug = `keep-${crypto.randomUUID().slice(0, 8)}`;
    const account = await ensureDevAccount(connectionString!, { email, password: "local-password", organization: { slug }, applicationRoles: ["editor"] });
    const database = createDatabase(connectionString!, "postgres-js");
    const [record] = await database.insert(tenantRecord).values({ organizationId: account.organizationId!, name: "Custom data" }).returning();
    await applySeedScenario("default", connectionString!);
    await applySeedScenario("demo", connectionString!);
    expect(await database.select({ email: user.email }).from(user).where(eq(user.id, account.userId))).toEqual([{ email }]);
    expect(await database.select({ organizationId: member.organizationId }).from(member).where(eq(member.userId, account.userId))).toEqual([{ organizationId: account.organizationId }]);
    expect(await database.select({ name: tenantRecord.name }).from(tenantRecord).where(eq(tenantRecord.id, record!.id))).toEqual([{ name: "Custom data" }]);
    expect(await database.select({ id: user.id }).from(user).where(eq(user.id, "seed-user-alice"))).toHaveLength(1);
  });
});
