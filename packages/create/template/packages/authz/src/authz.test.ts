import { describe, expect, it } from "vitest";

import { AccessDeniedError, AccessEvaluator, publicDenial } from "./access.js";
import { permissions } from "./permissions.js";
import { memberDefaultApplicationRoles, organizationCreatorApplicationRoles, unknownApplicationRoles } from "./policies.js";
import { definePermissions, PermissionRegistryError } from "./registry.js";
import { applicationRoles, organizationRoles } from "./role-definitions.js";
import { defineRoles, parseMembershipRoles, RoleDefinitionError } from "./roles.js";
import { defineRoutePolicies, RoutePolicyError } from "./route-policy.js";
import { customerRoutePolicies, defaultResourcePolicy, policyFor } from "./routes.js";

const subject = (organization: readonly string[], application: readonly string[]) => new AccessEvaluator(permissions, {
  principal: { type: "user", id: "user-1" },
  tenant: { organizationId: "org-a" },
  authority: { organization: organizationRoles.resolve(organization).permissions, application: applicationRoles.resolve(application).permissions },
  assignments: { organization, application },
});

describe("permission registry", () => {
  it("assigns every permission exactly one plane and enforces reserved prefixes", () => {
    expect(permissions.require("organization.webhooks.manage").plane).toBe("organization");
    expect(permissions.require("resource.write").plane).toBe("application");
    expect(() => definePermissions({ "organization.x": { plane: "application", description: "x" } })).toThrow(PermissionRegistryError);
    expect(() => definePermissions({ "reports.read": { plane: "organization", description: "x" } })).toThrow("must use the organization. prefix");
    expect(() => definePermissions({ "Bad:Code": { plane: "application", description: "x" } })).toThrow("lowercase dotted");
  });
});

describe("roles", () => {
  it("never let a role grant a permission from another plane", () => {
    expect(() => defineRoles(permissions, "organization", { owner: { name: "Owner", description: "x", permissions: ["resource.write"] } })).toThrow(RoleDefinitionError);
    expect(() => defineRoles(permissions, "application", { editor: { name: "Editor", description: "x", permissions: ["organization.billing.manage"] } })).toThrow("cannot grant organization permission");
  });

  it("keeps organization and application authority independent", () => {
    for (const role of organizationRoles.list()) expect(role.permissions.every((code) => code.startsWith("organization."))).toBe(true);
    for (const role of applicationRoles.list()) expect(role.permissions.every((code) => permissions.require(code).plane === "application")).toBe(true);
  });

  it("records which roles granted each permission and reports unknown roles", () => {
    const resolved = applicationRoles.resolve(["reader", "editor", "ghost"]);
    expect(resolved.permissions.get("resource.read")).toEqual(["editor", "reader"]);
    expect(resolved.unknownRoles).toEqual(["ghost"]);
    expect(parseMembershipRoles("owner, admin,owner")).toEqual(["admin", "owner"]);
  });

  it("uses only catalog roles in membership policy", () => {
    expect(organizationCreatorApplicationRoles).toEqual(["app_admin"]);
    expect(unknownApplicationRoles([...organizationCreatorApplicationRoles, ...memberDefaultApplicationRoles])).toEqual([]);
    expect(unknownApplicationRoles(["editor", "root"])).toEqual(["root"]);
  });
});

describe("access evaluation", () => {
  it("allows only what a plane's own assignments grant and explains why", () => {
    const owner = subject(["owner"], []);
    expect(owner.check({ permission: "organization.billing.manage" })).toBe(true);
    expect(owner.explain({ permission: "resource.read" })).toMatchObject({ allowed: false, reason: "permission_missing", permission: { plane: "application", granted: false }, assignments: { organization: ["owner"], application: [] } });
    expect(subject(["member"], ["editor"]).explain({ permission: "resource.write" })).toMatchObject({ allowed: true, permission: { grantedBy: ["editor"] } });
  });

  it("fails closed on unknown permissions and missing entitlements", () => {
    expect(subject(["owner"], ["app_admin"]).explain({ permission: "resource.delete_everything" }).reason).toBe("unknown_permission");
    const entitled = new AccessEvaluator(permissions, { principal: { type: "user", id: "u" }, tenant: { organizationId: "o" }, authority: { application: applicationRoles.resolve(["editor"]).permissions }, entitlements: { get: () => ({ code: "workflows.advanced", enabled: false, source: "default" }) } });
    const decision = entitled.explain({ permission: "resource.write", entitlement: "workflows.advanced" });
    expect(decision.reason).toBe("entitlement_missing");
    expect(publicDenial(decision)).toEqual({ error: "entitlement_required", reason: "entitlement_missing", entitlement: "workflows.advanced" });
  });

  it("throws a status-carrying denial", () => {
    expect(() => subject(["member"], ["reader"]).require({ permission: "resource.write" })).toThrow(AccessDeniedError);
    try { subject(["member"], ["reader"]).require({ permission: "resource.write" }); } catch (error) { expect((error as AccessDeniedError).status).toBe(403); }
  });
});

describe("route policies", () => {
  it("rejects duplicate, unregistered, and unauthenticated tenant policies", () => {
    expect(() => defineRoutePolicies(permissions, [{ method: "GET", path: "/x", audience: "tenant", permission: "resource.read" }, { method: "GET", path: "/x", audience: "tenant", permission: "resource.read" }])).toThrow(RoutePolicyError);
    expect(() => defineRoutePolicies(permissions, [{ method: "GET", path: "/x", audience: "tenant", permission: "nope.read" }])).toThrow("unregistered");
    expect(() => defineRoutePolicies(permissions, [{ method: "GET", path: "/x", audience: "tenant" }])).toThrow("must declare a permission");
  });

  it("matches concrete paths and gives generated resources a default policy", () => {
    expect(policyFor("DELETE", "/api/artifacts/0b7c0f10-0000-4000-8000-000000000000")?.permission).toBe("resource.write");
    expect(policyFor("HEAD", "/api/billing/subscription")?.permission).toBe("organization.billing.read");
    expect(policyFor("GET", "/api/articles")).toBeUndefined();
    expect(defaultResourcePolicy("GET", "/api/articles").permission).toBe("resource.read");
    expect(defaultResourcePolicy("POST", "/api/articles").permission).toBe("resource.write");
    // Artifacts are product resources; no organization permission may reach them.
    expect(customerRoutePolicies.filter((policy) => policy.path.startsWith("/api/artifacts")).every((policy) => policy.permission?.startsWith("resource."))).toBe(true);
  });
});
