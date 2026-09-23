/**
 * Application event catalog. Every event that application code emits through
 * `ctx.events` is registered here, and only events with a `webhook` projection
 * are ever delivered to tenant endpoints. The projection is the whole public
 * contract: internal payload fields that it does not copy never leave the
 * application.
 */
export type EventPayload = Readonly<Record<string, unknown>>;

export type WebhookProjection = Readonly<{
  /** Public event name that tenants subscribe to, such as `api_key.created`. */
  name: string;
  version: number;
  description: string;
  project: (payload: EventPayload, resource: Readonly<{ type: string; id: string }>) => Readonly<Record<string, unknown>>;
}>;

export type ApplicationEventDefinition = Readonly<{
  description: string;
  webhook?: WebhookProjection;
}>;

export type WebhookEventType = Readonly<{ name: string; version: number; description: string }>;

export type EventCatalog = Readonly<{
  has(name: string): boolean;
  get(name: string): ApplicationEventDefinition | undefined;
  /** Public webhook event types, sorted by name. */
  webhookEvents(): WebhookEventType[];
  /** The internal event that publishes a public webhook event, if any. */
  forWebhook(name: string): { source: string; definition: WebhookProjection } | undefined;
}>;

export class EventCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventCatalogError";
  }
}

const eventName = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u;

export function defineEventCatalog(definitions: Readonly<Record<string, ApplicationEventDefinition>>): EventCatalog {
  const byWebhook = new Map<string, { source: string; definition: WebhookProjection }>();
  for (const [name, definition] of Object.entries(definitions)) {
    if (!eventName.test(name)) throw new EventCatalogError(`Event ${name} must be a lowercase dotted name`);
    if (!definition.webhook) continue;
    if (!eventName.test(definition.webhook.name)) throw new EventCatalogError(`Webhook event ${definition.webhook.name} must be a lowercase dotted name`);
    if (definition.webhook.name === testWebhookEvent.name) throw new EventCatalogError(`${testWebhookEvent.name} is reserved for endpoint tests`);
    if (byWebhook.has(definition.webhook.name)) throw new EventCatalogError(`Webhook event ${definition.webhook.name} is published by more than one event`);
    byWebhook.set(definition.webhook.name, { source: name, definition: definition.webhook });
  }
  return {
    has: (name) => Object.hasOwn(definitions, name),
    get: (name) => definitions[name],
    webhookEvents: () => [...byWebhook.values()].map(({ definition }) => ({ name: definition.name, version: definition.version, description: definition.description })).sort((a, b) => a.name.localeCompare(b.name)),
    forWebhook: (name) => byWebhook.get(name),
  };
}

/** Sent only by "Send test event"; marked `test: true` and never produced by application events. */
export const testWebhookEvent: WebhookEventType = { name: "webhook.test", version: 1, description: "A marked test delivery sent from the endpoint settings" };

const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const texts = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export const applicationEvents = defineEventCatalog({
  "access.api_key.minted": {
    description: "An API key was minted for a service account",
    webhook: { name: "api_key.created", version: 1, description: "An API key was created", project: (payload, resource) => ({ apiKeyId: resource.id, serviceAccountId: text(payload.serviceAccountId), displayPrefix: text(payload.displayPrefix), scopes: texts(payload.scopes), expiresAt: text(payload.expiresAt) }) },
  },
  "access.api_key.rotated": {
    description: "An API key was rotated",
    webhook: { name: "api_key.rotated", version: 1, description: "An API key was replaced; the previous key works until its overlap ends", project: (payload, resource) => ({ apiKeyId: text(payload.replacement), previousApiKeyId: resource.id, previousExpiresAt: text(payload.previousExpiresAt) }) },
  },
  "access.api_key.revoked": {
    description: "An API key was revoked by the organization or the platform",
    webhook: { name: "api_key.revoked", version: 1, description: "An API key was revoked", project: (payload, resource) => ({ apiKeyId: resource.id, displayPrefix: text(payload.displayPrefix), revokedBy: payload.by === "platform" ? "platform" : "organization" }) },
  },
  "access.service_account.created": {
    description: "A service account was created",
    webhook: { name: "service_account.created", version: 1, description: "A service account was created", project: (payload, resource) => ({ serviceAccountId: resource.id, name: text(payload.name), applicationRoles: texts(payload.applicationRoles) }) },
  },
  "access.service_account.roles_changed": { description: "A service account's application roles changed" },
  "access.service_account.suspended": {
    description: "A service account was suspended",
    webhook: { name: "service_account.suspended", version: 1, description: "A service account was suspended", project: (payload, resource) => ({ serviceAccountId: resource.id, suspendedBy: payload.by === "platform" ? "platform" : "organization" }) },
  },
  "access.service_account.reactivated": {
    description: "A suspended service account was reactivated",
    webhook: { name: "service_account.reactivated", version: 1, description: "A service account was reactivated", project: (_payload, resource) => ({ serviceAccountId: resource.id }) },
  },
  "access.organization_roles.changed": {
    description: "A member's organization roles changed",
    webhook: { name: "member.organization_roles_changed", version: 1, description: "A member's organization roles changed", project: (payload, resource) => ({ memberId: resource.id, userId: text(payload.userId), before: texts(payload.before), after: texts(payload.after) }) },
  },
  "access.application_roles.assigned": {
    description: "A user's application roles changed",
    webhook: { name: "member.application_roles_changed", version: 1, description: "A member's application roles changed", project: (payload, resource) => ({ userId: resource.id, before: texts(payload.before), after: texts(payload.after) }) },
  },
  "webhooks.endpoint.failing": { description: "A webhook endpoint crossed its consecutive-failure threshold" },
});
