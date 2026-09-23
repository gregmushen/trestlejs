import { definePermissions } from "./registry.js";

/**
 * The reviewed permission registry. Every permission belongs to exactly one
 * authority plane: organization permissions govern the account, application
 * permissions govern product actions, and platform permissions govern
 * operating the SaaS from the optional platform admin. Authority never flows
 * between planes.
 *
 * Naming: `<plane-prefix>.<area>[.<sub-area>].<verb>`, lowercase and dotted.
 * Organization and platform codes must start with `organization.` or
 * `platform.`; application codes use product nouns (`resource.read`).
 * Add application permissions for your product's own actions here.
 */
export const permissions = definePermissions({
  "organization.read": { plane: "organization", description: "Read the organization profile and your own effective access" },
  "organization.members.read": { plane: "organization", description: "List organization members and their roles" },
  "organization.audit.read": { plane: "organization", description: "Read the organization's redacted audit history" },
  "organization.billing.read": { plane: "organization", description: "Read the subscription and plan" },
  "organization.billing.manage": { plane: "organization", description: "Start checkout and open the billing portal" },
  "organization.webhooks.read": { plane: "organization", description: "List webhook endpoints, subscriptions, and public event types" },
  "organization.webhooks.manage": { plane: "organization", description: "Create, pause, and change webhook endpoints and subscriptions" },
  "organization.webhooks.deliveries.read": { plane: "organization", description: "Inspect webhook deliveries and attempts" },

  "resource.read": { plane: "application", description: "Read tenant-owned application resources" },
  "resource.write": { plane: "application", description: "Create, update, and delete tenant-owned application resources" },
  "application.roles.read": { plane: "application", description: "List application-role assignments in the organization" },
  "application.roles.assign": { plane: "application", description: "Grant and revoke application roles for organization members" },

  "platform.overview.read": { plane: "platform", description: "Read the platform overview and capability health" },
  "platform.organizations.read": { plane: "platform", description: "Search organizations and read their sanitized summaries" },
  "platform.audit.read": { plane: "platform", description: "Read administrative and access audit history" },
  "platform.roles.read": { plane: "platform", description: "Read platform-role assignments" },
  "platform.roles.manage": { plane: "platform", description: "Grant and revoke platform roles" },
});

export type PermissionCode = (typeof permissions.codes)[number];
