import { definePermissions } from "./registry.js";

/**
 * Application-owned permission registry. Every permission belongs to exactly
 * one authority plane. New permission meaning enters only through reviewed
 * source; runtime administration can group, assign, and deprecate these codes
 * but cannot invent new ones.
 */
export const permissions = definePermissions({
  // Organization plane: the SaaS account relationship.
  "organization.read": { plane: "organization", description: "Read organization profile and settings" },
  "organization.manage": { plane: "organization", description: "Update organization profile and settings" },
  "organization.members.read": { plane: "organization", description: "List members and invitations" },
  "organization.members.invite": { plane: "organization", description: "Invite members to the organization" },
  "organization.members.remove": { plane: "organization", description: "Remove members from the organization" },
  "organization.roles.assign": { plane: "organization", description: "Assign organization roles to members" },
  "organization.billing.read": { plane: "organization", description: "Read the subscription, plan, and invoices" },
  "organization.billing.manage": { plane: "organization", description: "Manage organization billing settings" },
  "organization.entitlements.read": { plane: "organization", description: "Read plan capabilities, limits, and usage" },
  "organization.service_accounts.read": { plane: "organization", description: "List service accounts and API-key metadata", entitlement: "api.access" },
  "organization.service_accounts.manage": { plane: "organization", description: "Create and suspend service accounts", entitlement: "api.access" },
  "organization.api_keys.manage": { plane: "organization", description: "Mint, rotate, and revoke API keys", entitlement: "api.access", secret: true },
  "organization.webhooks.read": { plane: "organization", description: "Read webhook endpoints, health, and delivery attempts" },
  "organization.webhooks.manage": { plane: "organization", description: "Create, edit, pause, disable, delete, and test webhook endpoints" },
  "organization.webhooks.rotate_secret": { plane: "organization", description: "Rotate webhook endpoint signing secrets", secret: true },
  "organization.webhooks.replay": { plane: "organization", description: "Replay eligible webhook deliveries" },
  "organization.notifications.read": { plane: "organization", description: "Read organization-wide notification delivery history" },
  "organization.notifications.manage": { plane: "organization", description: "Set organization default notification preferences" },
  "organization.settings.regional.read": { plane: "organization", description: "Read the organization's language, locale, time zone, and currency defaults" },
  "organization.settings.regional.manage": { plane: "organization", description: "Change the organization's regional defaults; never rewrites historical data" },
  "organization.audit.read": { plane: "organization", description: "Read the organization audit history" },
  "organization.identity.read": { plane: "organization", description: "Read SSO connections, directory provisioning status, and group mappings" },
  "organization.identity.manage": { plane: "organization", description: "Configure SSO, SCIM credentials, and directory group-to-role mappings", secret: true },

  // Application plane: product-domain authority.
  "application.roles.read": { plane: "application", description: "Read application roles and their assignments" },
  "application.roles.assign": { plane: "application", description: "Assign application roles to members and service accounts" },
  "application.roles.manage": { plane: "application", description: "Create, update, and delete custom application roles", entitlement: "roles.custom" },
  "resource.read": { plane: "application", description: "Read tenant-owned application resources", principals: ["user", "api_key"] },
  "resource.write": { plane: "application", description: "Create, update, and delete tenant-owned application resources", principals: ["user", "api_key"] },
  "workflows.read": { plane: "application", description: "Read workflows and execution status", principals: ["user", "api_key"] },
  "workflows.publish": { plane: "application", description: "Publish workflow definitions", principals: ["user", "api_key"], entitlement: "workflows.advanced" },

  // Platform plane: operating the SaaS across tenants.
  "platform.overview.read": { plane: "platform", description: "Read sanitized platform health and deployment state" },
  "platform.organizations.read": { plane: "platform", description: "Search organizations across tenants" },
  "platform.organizations.regional.read": { plane: "platform", description: "Inspect an organization's regional configuration and explain a user's effective regional context" },
  "platform.organizations.regional.recover": { plane: "platform", description: "Repair an organization's regional defaults with step-up, a reason, and audit" },
  "platform.users.read": { plane: "platform", description: "Search users and their assignments across tenants" },
  "platform.users.suspend": { plane: "platform", description: "Suspend and restore users" },
  "platform.sessions.revoke": { plane: "platform", description: "Revoke user sessions" },
  "platform.support.enter_tenant": { plane: "platform", description: "Start an audited, time-boxed support session in a tenant" },
  "platform.support.read": { plane: "platform", description: "Read active and historical support sessions" },
  "platform.support.revoke": { plane: "platform", description: "Revoke another operator's active support session" },
  "platform.webhooks.read": { plane: "platform", description: "Inspect webhook endpoint health and delivery failures across tenants" },
  "platform.webhooks.disable": { plane: "platform", description: "Emergency-disable a tenant webhook endpoint" },
  "platform.webhooks.replay": { plane: "platform", description: "Replay an eligible tenant webhook delivery" },
  "platform.notifications.read": { plane: "platform", description: "Inspect notification delivery state across tenants" },
  "platform.notifications.manage": { plane: "platform", description: "Retry failed or cancel pending optional notification deliveries" },
  "platform.plans.read": { plane: "platform", description: "Read features, plans, and plan versions" },
  "platform.plans.manage": { plane: "platform", description: "Draft, activate, grandfather, and retire plan versions" },
  "platform.subscriptions.read": { plane: "platform", description: "Read subscription projections and history" },
  "platform.subscriptions.manage": { plane: "platform", description: "Apply overrides and schedule subscription changes" },
  "platform.reconciliation.run": { plane: "platform", description: "Reconcile provider state with local projections" },
  "platform.roles.read": { plane: "platform", description: "Read role registries and assignments in every plane" },
  "platform.roles.manage": { plane: "platform", description: "Assign and revoke platform roles" },
  "platform.access.explain": { plane: "platform", description: "Explain effective access without executing actions" },
  "platform.machine_access.read": { plane: "platform", description: "Read service-account and API-key metadata across tenants" },
  "platform.machine_access.revoke": { plane: "platform", description: "Suspend service accounts and revoke compromised API keys" },
  "platform.email.read": { plane: "platform", description: "Read provider-neutral email delivery status" },
  "platform.jobs.read": { plane: "platform", description: "Inspect outbox, queue, DLQ, and workflow state" },
  "platform.jobs.redrive": { plane: "platform", description: "Retry and redrive failed platform jobs" },
  "platform.artifacts.read": { plane: "platform", description: "Read artifact metadata and retention state" },
  "platform.audit.read": { plane: "platform", description: "Read administrative and access audit history" },
  "platform.identity.read": { plane: "platform", description: "Read enterprise identity connection and provisioning status across tenants" },
  "platform.access_catalog.manage": { plane: "platform", description: "Create, edit, clone, archive, and delete catalog roles and runtime permissions" },
  "platform.tenant_access.assign": { plane: "platform", description: "Assign organization and application roles to members and service accounts in a tenant" },
  "platform.machine_access.manage": { plane: "platform", description: "Create and delete service accounts; create, rotate, and replace API keys in a tenant", secret: true },
  "platform.webhooks.manage": { plane: "platform", description: "Create, edit, test, rotate, and delete tenant webhook endpoints", secret: true },
  "platform.notification_streams.manage": { plane: "platform", description: "Draft, publish, and archive notification streams" },
  "platform.auth_policy.read": { plane: "platform", description: "Read authentication posture, policy versions, and safeguard status" },
  "platform.auth_policy.manage": { plane: "platform", description: "Draft, activate, and roll back authentication policy" },
});

export type PermissionCode = (typeof permissions.codes)[number];
