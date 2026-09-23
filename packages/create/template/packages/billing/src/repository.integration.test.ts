import { createDatabase, organizationEntitlement, organizationEntitlementOverride, organizationSubscription, type DatabaseDriver } from "@__TRESTLE_PROJECT_NAME__/db";
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

  it("returns override provenance to customers without the operator's reason or author", async () => {
    const organizationId = `billing-override-${crypto.randomUUID()}`;
    const repository = new PostgresBillingProjectionRepository(runtimeConnectionString ?? connectionString!, "postgres-js");
    const database = createDatabase(connectionString!, "postgres-js");
    try {
      await repository.put({ organizationId, provider: "local", plan: "pro", planVersion: 1, status: "active", cancelAtPeriodEnd: false, entitlements: ["article.basic"] });
      await database.insert(organizationEntitlementOverride).values({ organizationId, entitlement: "workflows.advanced", enabled: true, reason: "internal: retention offer for churn risk", authorId: "operator-9", effectiveAt: new Date(Date.now() - 60_000) });
      const subscription = await repository.get(organizationId);
      expect(subscription?.effectiveEntitlements).toContainEqual(expect.objectContaining({ code: "workflows.advanced", enabled: true, source: "override", inheritedFrom: "contract" }));
      expect(JSON.stringify(subscription)).not.toMatch(/retention offer|churn|operator-9/u);
    } finally {
      await database.delete(organizationEntitlementOverride).where(eq(organizationEntitlementOverride.organizationId, organizationId));
      await database.delete(organizationEntitlement).where(eq(organizationEntitlement.organizationId, organizationId));
      await database.delete(organizationSubscription).where(eq(organizationSubscription.organizationId, organizationId));
    }
  });
});

