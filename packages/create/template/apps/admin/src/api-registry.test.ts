import { describe, expect, it } from "vitest";

import { AdminViewError, adminViews, defineAdminViews } from "./api-registry";

describe("admin view registry", () => {
  it("requires unique views guarded by registered platform permissions", () => {
    expect(adminViews.map((view) => view.id)).toEqual(["overview", "health", "async", "webhooks", "organizations", "users", "audit", "platform-roles", "organization-roles", "application-roles", "permissions", "service-accounts", "email", "support-sessions", "subscriptions", "api-keys", "artifacts"]);
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
});
