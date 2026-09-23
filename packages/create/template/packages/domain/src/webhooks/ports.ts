import type { Mutation } from "../access/ports.js";
import type { DeliveryStatus, EndpointState } from "./model.js";

/** Tenant read model. Never includes the signing secret or its ciphertext. */
export type WebhookEndpoint = Readonly<{
  id: string;
  name: string;
  /** Full URL, tenant-side only. Platform read models use `urlDisplay`. */
  url: string;
  urlDisplay: string;
  events: readonly string[];
  state: EndpointState;
  disabledReason: string | null;
  disabledBy: string | null;
  consecutiveFailures: number;
  secretFingerprint: string;
  secretCreatedAt: Date;
  previousSecretExpiresAt: Date | null;
  verifiedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdBy: string;
  createdAt: Date;
  description?: string | null;
  /** Delivery timeout for this endpoint, 1-30 seconds. */
  timeoutMs?: number;
  /** Set once the endpoint is deleted: it is a tombstone that never receives deliveries. */
  deletedAt?: Date | null;
}>;

export type WebhookDelivery = Readonly<{
  id: string;
  endpointId: string;
  eventId: string;
  eventName: string;
  eventVersion: number;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastResponseCode: number | null;
  failureCategory: string | null;
  correlationId: string;
  test: boolean;
  replayOf: string | null;
  createdAt: Date;
  completedAt: Date | null;
}>;

export type WebhookAttempt = Readonly<{ id: string; attemptedAt: Date; responseCode: number | null; failureCategory: string | null; durationMs: number; providerReference?: string | null }>;

export type EncryptedSecrets = Readonly<{ current: string; previous: string | null; previousExpiresAt: Date | null }>;

export type NewDelivery = Readonly<{ id: string; endpointId: string; eventId: string; eventName: string; eventVersion: number; payload: Readonly<Record<string, unknown>>; correlationId: string; test: boolean; replayOf: string | null }>;

export interface WebhookRepository {
  listEndpoints(): Promise<WebhookEndpoint[]>;
  getEndpoint(id: string): Promise<WebhookEndpoint | null>;
  encryptedSecrets(id: string): Promise<EncryptedSecrets | null>;
  createEndpoint(endpoint: WebhookEndpoint, secretCiphertext: string, mutation: Mutation): Promise<void>;
  updateEndpoint(id: string, changes: Readonly<{ name: string; url: string; urlDisplay: string; events: readonly string[]; description: string | null; timeoutMs: number }>, mutation: Mutation): Promise<void>;
  setEndpointState(id: string, state: EndpointState, reason: string | null, mutation: Mutation): Promise<void>;
  /** Tombstones the endpoint and cancels its pending deliveries; delivery history is kept. */
  deleteEndpoint(id: string, reason: string, mutation: Mutation): Promise<void>;
  rotateSecret(id: string, secretCiphertext: string, fingerprint: string, previousExpiresAt: Date, mutation: Mutation): Promise<void>;
  listDeliveries(endpointId: string, limit: number): Promise<WebhookDelivery[]>;
  getDelivery(id: string): Promise<(WebhookDelivery & { payload: Readonly<Record<string, unknown>> }) | null>;
  listAttempts(deliveryId: string): Promise<WebhookAttempt[]>;
  insertDelivery(delivery: NewDelivery, mutation?: Mutation): Promise<void>;
  /** Fans a published event out to every active endpoint subscribed to it; idempotent per endpoint and event. */
  enqueueEvent(event: Readonly<{ eventId: string; name: string; version: number; payload: Readonly<Record<string, unknown>>; correlationId: string }>): Promise<number>;
  recordAttempt(deliveryId: string, attempt: Omit<WebhookAttempt, "id">, next: Readonly<{ status: DeliveryStatus; nextAttemptAt: Date | null }>, crossedFailingThreshold?: Mutation): Promise<void>;
  cancelPending(endpointId: string): Promise<void>;
}
