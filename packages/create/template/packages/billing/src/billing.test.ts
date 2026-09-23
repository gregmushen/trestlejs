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

  it("explains plan inheritance and time-bounded overrides", () => {
    const now = new Date("2026-09-22T12:00:00.000Z");
    const entitlements = new Entitlements(new Set(["article.basic", "workflows.advanced"]), { plan: "pro", planVersion: 1, now, overrides: [{ code: "workflows.advanced", enabled: false, reason: "account review", authorId: "operator-1", effectiveAt: new Date("2026-09-22T11:00:00.000Z") }, { code: "support.priority", enabled: true, reason: "contract", authorId: "operator-1", effectiveAt: new Date("2026-09-22T11:00:00.000Z"), expiresAt: new Date("2026-10-22T11:00:00.000Z") }] });
    expect(entitlements.has("workflows.advanced")).toBe(false);
    expect(entitlements.resolve("support.priority")).toMatchObject({ enabled: true, source: "override", inheritedFrom: "contract" });
    expect(entitlements.resolve("article.basic")).toMatchObject({ enabled: true, source: "plan", inheritedFrom: "pro@1" });
  });

  it("never exposes an override's internal reason or author in customer-visible provenance", () => {
    const now = new Date("2026-09-22T12:00:00.000Z");
    const entitlements = new Entitlements(new Set(["article.basic"]), { plan: "pro", planVersion: 1, now, overrides: [
      { code: "workflows.advanced", enabled: true, reason: "churn risk: CFO escalation, 40% discount", authorId: "operator-7", effectiveAt: new Date("2026-09-22T11:00:00.000Z") },
    ] });
    expect(entitlements.resolve("workflows.advanced")).toMatchObject({ enabled: true, source: "override", inheritedFrom: "contract" });
    const customerView = JSON.stringify(entitlements.explain());
    expect(customerView).not.toMatch(/churn|CFO|discount|operator-7/u);
  });
});

