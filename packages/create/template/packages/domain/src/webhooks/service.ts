import { applicationEvents, testWebhookEvent, type EventCatalog } from "@__TRESTLE_PROJECT_NAME__/events";

import type { Mutation, OperationContext } from "../access/ports.js";
import { afterAttempt, assertTransition, failingThreshold, failureCategory, replayProblem, sanitizeEndpointUrl, validateEndpointUrl, WebhookDomainError, type EndpointState } from "./model.js";
import type { NewDelivery, WebhookDelivery, WebhookEndpoint, WebhookRepository } from "./ports.js";
import { generateSigningSecret, secretFingerprint, type SecretCipher } from "./signing.js";
import { NativeWebhookTransport, type WebhookTransport } from "./transport.js";

function mutation(context: OperationContext, name: string, targetType: string, targetId: string, summary: Record<string, unknown>, reason?: string): Mutation {
  return {
    context,
    audit: { name, targetType, targetId, summary, outcome: "succeeded", ...(reason ? { reason } : {}) },
    event: { name, resourceType: targetType, resourceId: targetId, payload: { organizationId: context.organizationId, ...summary } },
  };
}

const eventBody = (id: string, type: string, version: number, organizationId: string, occurredAt: Date, data: Readonly<Record<string, unknown>>, test: boolean) =>
  ({ id, type, version, timestamp: occurredAt.toISOString(), organizationId, test, data });

export type EndpointInput = Readonly<{ name: string; url: string; events: readonly string[]; description?: string | null | undefined; timeoutMs?: number | undefined }>;

export const defaultEndpointTimeoutMs = 10_000;

/**
 * Tenant webhook administration. Endpoints subscribe only to registered public
 * events, secrets are returned exactly once, and every change is audited.
 */
export class WebhookService {
  constructor(private readonly repository: WebhookRepository, private readonly cipher: SecretCipher, private readonly catalog: EventCatalog = applicationEvents) {}

  eventTypes() {
    return this.catalog.webhookEvents();
  }

  private validate(context: OperationContext, input: EndpointInput) {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new WebhookDomainError("invalid", "Endpoint names must be 1 to 80 characters");
    const url = validateEndpointUrl(input.url, context.environment);
    const known = new Set(this.catalog.webhookEvents().map((event) => event.name));
    const events = [...new Set(input.events)].sort();
    if (events.length === 0) throw new WebhookDomainError("invalid", "Subscribe to at least one event");
    const unknown = events.filter((event) => !known.has(event));
    if (unknown.length) throw new WebhookDomainError("invalid", `Unknown webhook events: ${unknown.join(", ")}`);
    const description = input.description?.trim() || null;
    if (description && description.length > 500) throw new WebhookDomainError("invalid", "Descriptions are at most 500 characters");
    const timeoutMs = input.timeoutMs ?? defaultEndpointTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) throw new WebhookDomainError("invalid", "The timeout must be between 1 and 30 seconds");
    return { name, url: url.toString(), urlDisplay: sanitizeEndpointUrl(url), events, description, timeoutMs };
  }

  async required(id: string): Promise<WebhookEndpoint> {
    const endpoint = await this.repository.getEndpoint(id);
    if (!endpoint || endpoint.deletedAt) throw new WebhookDomainError("not_found", "Webhook endpoint not found");
    return endpoint;
  }

  async create(context: OperationContext, input: EndpointInput): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    const valid = this.validate(context, input);
    const secret = generateSigningSecret();
    const endpoint: WebhookEndpoint = {
      id: `whe_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`, ...valid, state: "active", disabledReason: null, disabledBy: null, consecutiveFailures: 0,
      secretFingerprint: await secretFingerprint(secret), secretCreatedAt: context.now, previousSecretExpiresAt: null, verifiedAt: null, lastSuccessAt: null, lastFailureAt: null, createdBy: context.actor.id, createdAt: context.now,
    };
    await this.repository.createEndpoint(endpoint, await this.cipher.encrypt(secret), mutation(context, "webhooks.endpoint.created", "webhook_endpoint", endpoint.id, { name: endpoint.name, url: endpoint.urlDisplay, events: endpoint.events }));
    return { endpoint, secret };
  }

  /** Omitting the URL keeps the current one (operators only ever see the sanitized form). */
  async update(context: OperationContext, id: string, input: Omit<EndpointInput, "url"> & { url?: string | undefined }): Promise<void> {
    const current = await this.required(id);
    const valid = this.validate(context, { ...input, url: input.url?.trim() ? input.url : current.url });
    await this.repository.updateEndpoint(id, valid, mutation(context, "webhooks.endpoint.updated", "webhook_endpoint", id, { name: valid.name, url: valid.urlDisplay, before: { url: current.urlDisplay, events: current.events }, events: valid.events }));
  }

  async setState(context: OperationContext, id: string, to: EndpointState, reason?: string): Promise<void> {
    const current = await this.required(id);
    assertTransition(current.state, to);
    if (to === "disabled" && !reason?.trim()) throw new WebhookDomainError("invalid", "Disabling an endpoint requires a reason");
    const name = to === "active" ? "webhooks.endpoint.resumed" : to === "paused" ? "webhooks.endpoint.paused" : "webhooks.endpoint.disabled";
    await this.repository.setEndpointState(id, to, to === "disabled" ? reason!.trim() : null, mutation(context, name, "webhook_endpoint", id, { from: current.state, to }, reason?.trim()));
    // Disabled endpoints receive nothing; queued deliveries are cancelled rather than sent later.
    if (to === "disabled") await this.repository.cancelPending(id);
  }

  /**
   * Deletion disables and tombstones the endpoint and cancels queued work, so
   * no worker sends to it afterwards; deliveries and audit remain for history.
   */
  async delete(context: OperationContext, id: string, reason?: string): Promise<void> {
    const current = await this.required(id);
    const why = reason?.trim() || "deleted";
    await this.repository.deleteEndpoint(id, why, mutation(context, "webhooks.endpoint.deleted", "webhook_endpoint", id, { name: current.name, url: current.urlDisplay }, reason?.trim()));
  }

  /** The previous secret keeps signing, alongside the new one, until the overlap ends. */
  async rotateSecret(context: OperationContext, id: string, overlapHours = 24): Promise<{ secret: string; fingerprint: string; previousExpiresAt: Date }> {
    await this.required(id);
    if (overlapHours < 0 || overlapHours > 168) throw new WebhookDomainError("invalid", "The overlap must be between 0 and 168 hours");
    const secret = generateSigningSecret();
    const fingerprint = await secretFingerprint(secret);
    const previousExpiresAt = new Date(context.now.getTime() + overlapHours * 3_600_000);
    await this.repository.rotateSecret(id, await this.cipher.encrypt(secret), fingerprint, previousExpiresAt, mutation(context, "webhooks.endpoint.secret_rotated", "webhook_endpoint", id, { fingerprint, previousExpiresAt: previousExpiresAt.toISOString() }));
    return { secret, fingerprint, previousExpiresAt };
  }

  /** Queues a delivery marked `test: true`; the caller attempts it immediately. */
  async sendTest(context: OperationContext, id: string): Promise<string> {
    const endpoint = await this.required(id);
    if (endpoint.state !== "active") throw new WebhookDomainError("conflict", `The endpoint is ${endpoint.state}; resume it before testing`);
    const eventId = `evt_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const delivery: NewDelivery = {
      id: `whd_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`, endpointId: id, eventId, eventName: testWebhookEvent.name, eventVersion: testWebhookEvent.version,
      payload: eventBody(eventId, testWebhookEvent.name, testWebhookEvent.version, context.organizationId, context.now, { message: "This is a test event from your webhook settings." }, true),
      correlationId: context.correlationId, test: true, replayOf: null,
    };
    await this.repository.insertDelivery(delivery, mutation(context, "webhooks.endpoint.tested", "webhook_endpoint", id, { deliveryId: delivery.id }));
    return delivery.id;
  }

  async replay(context: OperationContext, deliveryId: string): Promise<string> {
    const original = await this.repository.getDelivery(deliveryId);
    if (!original) throw new WebhookDomainError("not_found", "Delivery not found");
    const endpoint = await this.required(original.endpointId);
    const problem = replayProblem(original, endpoint.state);
    if (problem) throw new WebhookDomainError("conflict", problem);
    const id = `whd_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    await this.repository.insertDelivery({ id, endpointId: original.endpointId, eventId: original.eventId, eventName: original.eventName, eventVersion: original.eventVersion, payload: original.payload, correlationId: context.correlationId, test: false, replayOf: original.id },
      mutation(context, "webhooks.delivery.replayed", "webhook_delivery", original.id, { replayId: id, endpointId: original.endpointId, event: original.eventName }));
    return id;
  }
}


/** Builds the public body for a registered event; returns null for internal-only events. */
export function publicWebhookEvent(catalog: EventCatalog, envelope: Readonly<{ id: string; name: string; occurredAt: string; resource: { type: string; id: string }; payload: unknown }>, organizationId: string) {
  const definition = catalog.get(envelope.name)?.webhook;
  if (!definition) return null;
  const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload as Record<string, unknown> : {};
  return { name: definition.name, version: definition.version, body: eventBody(envelope.id, definition.name, definition.version, organizationId, new Date(envelope.occurredAt), definition.project(payload, envelope.resource), false) };
}

/**
 * Attempts one delivery: signs with the current (and any overlapping previous)
 * secret, posts with a timeout, records the attempt without the response body,
 * and schedules a retry or completes the delivery.
 */
export class WebhookDispatcher {
  constructor(private readonly repository: WebhookRepository, private readonly cipher: SecretCipher, private readonly transport: WebhookTransport = new NativeWebhookTransport(), private readonly timeoutMs = 10_000, private readonly destinationGuard?: (url: string) => Promise<string | null>) {}

  async attempt(deliveryId: string, context: OperationContext): Promise<WebhookDelivery["status"] | "skipped"> {
    const delivery = await this.repository.getDelivery(deliveryId);
    if (!delivery || delivery.status !== "pending") return "skipped";
    const endpoint = await this.repository.getEndpoint(delivery.endpointId);
    const secrets = await this.repository.encryptedSecrets(delivery.endpointId);
    if (!endpoint || !secrets) return "skipped";
    if (endpoint.state === "disabled" || endpoint.deletedAt) { await this.repository.cancelPending(endpoint.id); return "cancelled"; }
    if (endpoint.state === "paused") return "skipped";
    const keys = [await this.cipher.decrypt(secrets.current)];
    if (secrets.previous && secrets.previousExpiresAt && secrets.previousExpiresAt > context.now) keys.push(await this.cipher.decrypt(secrets.previous));
    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(context.now.getTime() / 1000);
    const started = Date.now();
    // DNS-rebinding defense: the destination is resolved again right before each attempt.
    const blocked = this.destinationGuard ? await this.destinationGuard(endpoint.url) : null;
    const sent = blocked ? { responseCode: null, error: new Error(blocked) } : await this.transport.send({
      organizationId: context.organizationId, deliveryId: delivery.id, eventId: delivery.eventId, eventName: delivery.eventName,
      endpoint: { id: endpoint.id, url: endpoint.url, events: endpoint.events }, secrets: keys, body, payload: delivery.payload, timestamp, timeoutMs: endpoint.timeoutMs ?? this.timeoutMs,
    });
    const outcome = { responseCode: sent.responseCode, failureCategory: failureCategory(sent.responseCode, sent.error), durationMs: Date.now() - started, providerReference: sent.providerReference ?? null };
    const attempts = delivery.attempts + 1;
    const next = afterAttempt(attempts, outcome, context.now);
    const crossed = outcome.failureCategory !== null && endpoint.consecutiveFailures + 1 === failingThreshold;
    await this.repository.recordAttempt(delivery.id, { attemptedAt: context.now, ...outcome }, next, crossed ? {
      context,
      audit: { name: "webhooks.endpoint.failing", targetType: "webhook_endpoint", targetId: endpoint.id, summary: { consecutiveFailures: failingThreshold, failureCategory: outcome.failureCategory }, outcome: "succeeded" },
      event: { name: "webhooks.endpoint.failing", resourceType: "webhook_endpoint", resourceId: endpoint.id, payload: { organizationId: context.organizationId, endpointName: endpoint.name, url: endpoint.urlDisplay, failureCategory: outcome.failureCategory } },
    } : undefined);
    return next.status;
  }
}
