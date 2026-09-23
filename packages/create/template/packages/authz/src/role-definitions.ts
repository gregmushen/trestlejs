import { permissions } from "./permissions.js";
import { defineRoles } from "./roles.js";

const inPlane = (plane: "organization" | "application" | "platform") => permissions.list(plane).map(({ code }) => code);

/**
 * Organization roles are Better Auth membership roles (`member.role`). They
 * govern the account and never grant application permissions.
 */
export const organizationRoles = defineRoles(permissions, "organization", {
  owner: { name: "Owner", description: "Full control of the organization account", permissions: inPlane("organization") },
  admin: { name: "Administrator", description: "Manages the organization account, billing, and webhooks", permissions: inPlane("organization") },
  member: { name: "Member", description: "Belongs to the organization and can see its members", permissions: ["organization.read", "organization.members.read", "organization.billing.read"] },
});

/**
 * Application roles express product-domain authority and are assigned
 * separately from organization roles. These defaults are a starting point;
 * replace them with the product's own semantics.
 */
export const applicationRoles = defineRoles(permissions, "application", {
  app_admin: { name: "Application administrator", description: "Every product action, including application-role assignment", permissions: inPlane("application") },
  editor: { name: "Editor", description: "Creates and changes product resources", permissions: ["resource.read", "resource.write", "application.roles.read"] },
  reader: { name: "Reader", description: "Read-only product access", permissions: ["resource.read"] },
});

/**
 * Platform roles operate the SaaS from the optional admin. They are distinct
 * from organization roles, application roles, and database privileges, and
 * grant no authority inside any tenant.
 */
export const platformRoles = defineRoles(permissions, "platform", {
  platform_operator: { name: "Platform operator", description: "Reads platform health, organizations, operations, and audit history; redrives events and recovers webhooks", permissions: ["platform.overview.read", "platform.organizations.read", "platform.audit.read", "platform.operations.read", "platform.outbox.redrive", "platform.webhooks.manage", "platform.support_sessions.use"] },
  commercial_admin: { name: "Commercial administrator", description: "Reads subscriptions and grants or revokes entitlement overrides", permissions: ["platform.overview.read", "platform.organizations.read", "platform.subscriptions.read", "platform.entitlements.manage"] },
  security_admin: { name: "Security administrator", description: "Manages platform roles, reads audit history, and revokes compromised API keys", permissions: ["platform.overview.read", "platform.audit.read", "platform.roles.read", "platform.roles.manage", "platform.machine_access.read", "platform.api_keys.revoke"] },
});

export const roleCatalogs = { organization: organizationRoles, application: applicationRoles, platform: platformRoles } as const;
