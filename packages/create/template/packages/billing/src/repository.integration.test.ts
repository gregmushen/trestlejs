import { createDatabase, organizationEntitlement, organizationSubscription, type DatabaseDriver } from "@__TRESTLE_PROJECT_NAME__/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PostgresBillingProjectionRepository } from "./repository.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const runtimeConnectionString = process.env.TRESTLE_RLS_TEST_RUNTIME_URL;
const suite = connectionString ? describe : describe.skip;
const drivers: DatabaseDriver[] = process.env.TRESTLE_RLS_TEST_NEON === "1" ? ["postgres-js", "neon-serverless"] : ["postgres-js"];

suite("tenant-scoped billing projection", () => {
  it.each(drivers)("writes and reads a subscription through the forced-RLS role using %s", async (driver) => {
    const organizationId = `billing-role-${crypto.randomUUID()}`;
    const repository = new PostgresBillingProjectionRepository(runtimeConnectionString ?? connectionString!, driver);
    try {
      await repository.put({ organizationId, provider: "local", plan: "pro", planVersion: 1, status: "active", cancelAtPeriodEnd: false, entitlements: ["workflows.advanced"] });
      const subscription = await repository.get(organizationId);
      expect(subscription).toMatchObject({ organizationId, plan: "pro", status: "active" });
      expect(subscription?.entitlements).toContain("workflows.advanced");
      await repository.put({ organizationId, provider: "local", plan: "starter", planVersion: 2, status: "active", cancelAtPeriodEnd: false, entitlements: [] });
      expect(await repository.get(organizationId)).toMatchObject({ plan: "starter", planVersion: 2, entitlements: [] });
    } finally {
      const database = createDatabase(connectionString!, "postgres-js");
      await database.delete(organizationEntitlement).where(eq(organizationEntitlement.organizationId, organizationId));
      await database.delete(organizationSubscription).where(eq(organizationSubscription.organizationId, organizationId));
    }
  });
});
