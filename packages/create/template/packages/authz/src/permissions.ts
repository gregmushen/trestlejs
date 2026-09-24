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
  "organization.webhooks.replay": { plane: "organization", description: "Replay a failed webhook delivery while its payload is retained" },
  "organization.settings.manage": { plane: "organization", description: "Change organization settings such as regional defaults" },

  "resource.read": { plane: "application", description: "Read tenant-owned application resources", principals: ["user", "api_key"] },
  "resource.write": { plane: "application", description: "Create, update, and delete tenant-owned application resources", principals: ["user", "api_key"] },
  "application.roles.read": { plane: "application", description: "List application-role assignments in the organization" },
  "application.roles.assign": { plane: "application", description: "Grant and revoke application roles for organization members" },
  "application.service_accounts.read": { plane: "application", description: "List service accounts and their API keys (never tokens)" },
  "application.service_accounts.manage": { plane: "application", description: "Create service accounts and mint, rotate, and revoke their scoped API keys" },

  "platform.overview.read": { plane: "platform", description: "Read the platform overview and capability health" },
  "platform.organizations.read": { plane: "platform", description: "Search organizations and read their sanitized summaries" },
  "platform.users.read": { plane: "platform", description: "Search users and read their verification state, memberships, and platform roles" },
  "platform.audit.read": { plane: "platform", description: "Read administrative and access audit history" },
  "platform.roles.read": { plane: "platform", description: "Read platform-role assignments" },
  "platform.roles.manage": { plane: "platform", description: "Grant and revoke platform roles" },
  "platform.operations.read": { plane: "platform", description: "Read async, webhook, and artifact operational metadata across organizations" },
  "platform.outbox.redrive": { plane: "platform", description: "Return dead-lettered outbox events to delivery" },
  "platform.webhooks.manage": { plane: "platform", description: "Disable webhook endpoints and replay failed deliveries" },
  "platform.subscriptions.read": { plane: "platform", description: "Read organizations' plans, subscriptions, and entitlement overrides with internal reasons" },
  "platform.entitlements.manage": { plane: "platform", description: "Grant and revoke entitlement overrides" },
  "platform.machine_access.read": { plane: "platform", description: "List service accounts and API key metadata across organizations" },
  "platform.api_keys.revoke": { plane: "platform", description: "Revoke an organization's API key, for example after a leak" },
  "platform.support_sessions.use": { plane: "platform", description: "Start, use, and end audited, time-boxed, read-only support sessions in one organization" },
});

export type PermissionCode = (typeof permissions.codes)[number];
