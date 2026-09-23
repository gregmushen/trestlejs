import { permissions } from "./permissions.js";
import { defineRoles } from "./roles.js";

const inPlane = (plane: "organization" | "application") => permissions.list(plane).map(({ code }) => code);

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

export const roleCatalogs = { organization: organizationRoles, application: applicationRoles } as const;
