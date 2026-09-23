import { permissions, type PermissionCode } from "./permissions.js";
import { defineRoles } from "./roles.js";

const inPlane = (plane: "organization" | "application" | "platform") => permissions.list(plane).map(({ code }) => code);
const readOnly = (codes: readonly PermissionCode[]) => codes.filter((code) => code.endsWith(".read"));

/**
 * Organization roles govern the SaaS account relationship only. None of them
 * grants application-domain or platform authority.
 */
export const organizationRoles = defineRoles(permissions, "organization", {
  owner: { name: "Owner", description: "Full account administration; no product-domain authority", permissions: inPlane("organization") },
  admin: {
    name: "Administrator",
    description: "Manages members, organization roles, and machine access",
    permissions: inPlane("organization").filter((code) => code !== "organization.billing.manage"),
  },
  billing_admin: {
    name: "Billing administrator",
    description: "Manages billing and reads plan usage",
    permissions: ["organization.read", "organization.billing.read", "organization.billing.manage", "organization.entitlements.read", "organization.settings.regional.read"],
  },
  member: {
    name: "Member",
    description: "Belongs to the organization and can see its members and plan",
    permissions: ["organization.read", "organization.members.read", "organization.entitlements.read", "organization.settings.regional.read"],
  },
});

/**
 * Application roles express product-domain authority. These defaults are a
 * starting point; replace them with the product's own semantics.
 */
export const applicationRoles = defineRoles(permissions, "application", {
  app_admin: { name: "Application administrator", description: "Administers application roles and every product action", permissions: inPlane("application") },
  editor: { name: "Editor", description: "Creates and changes product resources", permissions: ["resource.read", "resource.write", "workflows.read"] },
  publisher: { name: "Publisher", description: "Publishes workflow definitions", permissions: ["resource.read", "workflows.read", "workflows.publish"] },
  reader: { name: "Reader", description: "Read-only product access", permissions: ["resource.read", "workflows.read"] },
});

/** Platform roles are distinct from organization roles, application roles, and database privileges. */
export const platformRoles = defineRoles(permissions, "platform", {
  support: {
    name: "Support",
    description: "Finds customers and inspects sanitized state; may start audited support sessions",
    permissions: ["platform.overview.read", "platform.organizations.read", "platform.users.read", "platform.subscriptions.read", "platform.email.read", "platform.jobs.read", "platform.support.enter_tenant", "platform.support.read", "platform.access.explain", "platform.webhooks.read", "platform.notifications.read", "platform.identity.read", "platform.organizations.regional.read"],
  },
  billing_operations: {
    name: "Billing operations",
    description: "Manages plans, subscriptions, overrides, and reconciliation",
    permissions: ["platform.overview.read", "platform.organizations.read", "platform.plans.read", "platform.plans.manage", "platform.subscriptions.read", "platform.subscriptions.manage", "platform.reconciliation.run", "platform.audit.read", "platform.organizations.regional.read"],
  },
  platform_operator: {
    name: "Platform operator",
    description: "Operates asynchronous work, artifacts, and runtime health",
    permissions: [...readOnly(inPlane("platform")), "platform.jobs.redrive", "platform.support.enter_tenant", "platform.webhooks.disable", "platform.webhooks.replay", "platform.webhooks.manage", "platform.notifications.manage", "platform.notification_streams.manage", "platform.organizations.regional.recover"],
  },
  security_admin: {
    name: "Security administrator",
    description: "Manages platform roles and revokes sessions and machine credentials",
    permissions: ["platform.overview.read", "platform.users.read", "platform.users.suspend", "platform.sessions.revoke", "platform.roles.read", "platform.roles.manage", "platform.access.explain", "platform.machine_access.read", "platform.machine_access.revoke", "platform.audit.read", "platform.support.read", "platform.support.revoke", "platform.webhooks.read", "platform.webhooks.disable",
      "platform.access_catalog.manage", "platform.tenant_access.assign", "platform.machine_access.manage", "platform.auth_policy.read", "platform.auth_policy.manage", "platform.organizations.read", "platform.identity.read"],
  },
});

export const roleCatalogs = { organization: organizationRoles, application: applicationRoles, platform: platformRoles } as const;
