import { applicationEvents } from "@__TRESTLE_PROJECT_NAME__/events";

import { defineNotifications } from "./model.js";

const text = (value: unknown, fallback: string) => typeof value === "string" && value ? value : fallback;

/**
 * Application-owned notification definitions. Add a type here to make it
 * appear in every member's preferences; `trigger` connects it to a registered
 * event so the outbox raises it after the originating change commits.
 */
export const notifications = defineNotifications(applicationEvents, {
  "security.api_key_created": {
    name: "API key created",
    description: "A new API key can now access this organization's data",
    channels: { in_app: { default: true }, email: { default: false } },
    trigger: { event: "access.api_key.minted", recipients: { organizationRoles: ["owner", "admin"] } },
    group: { key: () => "api-keys", windowMinutes: 60 },
    dedupe: { key: (_payload, resource) => resource.id, windowMinutes: 24 * 60 },
    render: (payload, count) => count > 1
      ? { title: `${count} API keys created`, body: `The most recent is ${text(payload.displayPrefix, "a new key")}….`, link: "/settings/api-keys" }
      : { title: "API key created", body: `API key ${text(payload.displayPrefix, "")}… was created with ${Array.isArray(payload.scopes) ? payload.scopes.length : 0} scopes.`, link: "/settings/api-keys" },
    operatorActions: { retry: true, cancel: true },
  },
  "webhooks.endpoint_failing": {
    name: "Webhook endpoint failing",
    description: "A webhook endpoint has failed several deliveries in a row",
    channels: { in_app: { default: true }, email: { default: true } },
    mandatory: ["in_app"],
    trigger: { event: "webhooks.endpoint.failing", recipients: { organizationRoles: ["owner", "admin"] } },
    dedupe: { key: (_payload, resource) => resource.id, windowMinutes: 24 * 60 },
    render: (payload) => ({ title: "Webhook endpoint failing", body: `${text(payload.endpointName, "An endpoint")} (${text(payload.url, "unknown URL")}) is failing: ${text(payload.failureCategory, "delivery error")}.`, link: "/settings/webhooks" }),
    operatorActions: { retry: true, cancel: true },
  },
  "account.organization_roles_changed": {
    name: "Your organization roles changed",
    description: "An administrator changed your organization roles",
    channels: { in_app: { default: true }, email: { default: false } },
    trigger: { event: "access.organization_roles.changed", recipients: { userIdFrom: "userId" } },
    render: (payload) => ({ title: "Your organization roles changed", body: `Your roles are now: ${Array.isArray(payload.after) && payload.after.length ? payload.after.join(", ") : "none"}.`, link: "/settings/members" }),
    operatorActions: { retry: true },
  },
});
