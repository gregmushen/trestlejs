import { signPayload } from "./signing.js";

/**
 * Outbound webhook dispatch after the outbox commit. Trestle owns the event
 * catalog, subscriptions, correlation, and the local delivery projection; a
 * transport only moves one signed delivery to its destination.
 */
export type TransportRequest = Readonly<{
  organizationId: string;
  deliveryId: string;
  /** The Trestle event ID; also the Standard Webhooks `webhook-id`. */
  eventId: string;
  eventName: string;
  endpoint: Readonly<{ id: string; url: string; events: readonly string[] }>;
  /** Decrypted signing secrets: the current one, then any previous one still inside its overlap. */
  secrets: readonly string[];
  body: string;
  payload: Readonly<Record<string, unknown>>;
  timestamp: number;
  timeoutMs: number;
}>;

export type TransportResult = Readonly<{
  responseCode: number | null;
  error?: unknown;
  /** A provider's own message ID; a reference, never the Trestle event identity. */
  providerReference?: string;
}>;

export interface WebhookTransport {
  readonly kind: "native" | "svix";
  send(request: TransportRequest): Promise<TransportResult>;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Pick<Response, "status">>;

/** Direct delivery from the Worker with Standard Webhooks signatures. No redirects are followed. */
export class NativeWebhookTransport implements WebhookTransport {
  readonly kind = "native" as const;
  constructor(private readonly fetcher: Fetcher = (url, init) => fetch(url, init)) {}

  async send(request: TransportRequest): Promise<TransportResult> {
    try {
      const response = await this.fetcher(request.endpoint.url, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(request.timeoutMs),
        headers: {
          "content-type": "application/json", "user-agent": "TrestleJS-Webhooks/1",
          "webhook-id": request.eventId, "webhook-timestamp": String(request.timestamp),
          "webhook-signature": await signPayload(request.secrets, request.eventId, request.timestamp, request.body),
        },
        body: request.body,
      });
      return { responseCode: response.status };
    } catch (error) {
      return { responseCode: null, error };
    }
  }
}
