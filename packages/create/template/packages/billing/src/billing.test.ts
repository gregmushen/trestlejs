import { describe, expect, it } from "vitest";
import { InMemoryBillingProjectionRepository, LocalBillingAdapter } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { Entitlements, planEntitlements } from "./index.js";

describe("local billing and entitlements", () => {
  it("activates, changes, fails, resumes, and cancels deterministically", async () => {
    const repository = new InMemoryBillingProjectionRepository();
    const billing = new LocalBillingAdapter(repository, planEntitlements);
    await billing.activate({ organizationId: "org-1", plan: "starter" });
    expect(new Entitlements(new Set((await billing.getSubscription("org-1"))!.entitlements)).has("article.basic")).toBe(true);
    await billing.changePlan({ organizationId: "org-1", plan: "pro", commandId: "change-1" });
    expect((await billing.getSubscription("org-1"))!.entitlements).toContain("workflows.advanced");
    await billing.failPayment({ organizationId: "org-1" });
    expect((await billing.getSubscription("org-1"))!.status).toBe("past_due");
    await billing.resumeSubscription({ organizationId: "org-1", commandId: "resume-1" });
    await billing.cancelSubscription({ organizationId: "org-1", commandId: "cancel-1" });
    expect(await billing.getSubscription("org-1")).toMatchObject({ status: "cancelled", entitlements: [] });
  });
});
