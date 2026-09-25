import { describe, expect, it } from "vitest";

import { AdminViewError, adminViews, defineAdminViews, stepUpExemptRoutes } from "./api-registry";

describe("admin view registry", () => {
  it("requires unique views guarded by registered platform permissions", () => {
    expect(adminViews.map((view) => view.id)).toEqual(["overview", "health", "async", "webhooks", "organizations", "users", "audit", "platform-roles", "organization-roles", "application-roles", "permissions", "service-accounts", "email", "plans", "entitlements", "support-workspace", "support-sessions", "subscriptions", "api-keys", "artifacts", "account-security"]);
    const view = { id: "x", path: "/x", label: "X", group: "G", permission: "platform.overview.read", api: [] };
    expect(() => defineAdminViews([view, { ...view, path: "/y" }])).toThrow(AdminViewError);
    expect(() => defineAdminViews([{ ...view, permission: "organization.read" }])).toThrow("must require a platform permission");
    expect(() => defineAdminViews([{ ...view, permission: "platform.nope.read" }])).toThrow("unregistered");
    expect(() => defineAdminViews([{ ...view, api: [{ method: "GET", path: "/api/tenant/x" }] }])).toThrow("/api/admin/");
    expect(() => defineAdminViews([
      { ...view, api: [{ method: "GET", path: "/api/admin/x" }] },
      { ...view, id: "y", path: "/y", permission: "platform.audit.read", api: [{ method: "GET", path: "/api/admin/x" }] },
    ])).toThrow("different permissions");
    expect(() => defineAdminViews([{ ...view, api: [{ method: "POST", path: "/api/admin/x" }] }])).toThrow("must declare its own platform permission");
    expect(() => defineAdminViews([{ ...view, api: [{ method: "POST", path: "/api/admin/x", permission: "organization.webhooks.manage" }] }])).toThrow("must require a platform permission");
  });

  it("exempts only declared low-risk actions from fresh step-up, consistently across views", () => {
    expect([...stepUpExemptRoutes].sort()).toEqual(["POST /api/admin/access/explain", "POST /api/admin/support/sessions/:id/end"]);
    const view = { id: "x", path: "/x", label: "X", group: "G", permission: "platform.overview.read", api: [] };
    expect(() => defineAdminViews([{ ...view, api: [{ method: "GET", path: "/api/admin/x", stepUp: false }] }])).toThrow("only actions declare stepUp: false");
    expect(() => defineAdminViews([
      { ...view, api: [{ method: "POST", path: "/api/admin/x", permission: "platform.overview.read", stepUp: false }] },
      { ...view, id: "y", path: "/y", api: [{ method: "POST", path: "/api/admin/x", permission: "platform.overview.read" }] },
    ])).toThrow("different step-up requirements");
  });
});
