import type { TransportRequest, TransportResult, WebhookTransport } from "./transport.js";

export type SvixConfig = Readonly<{ apiKey: string; serverUrl?: string; fetcher?: (url: string, init: RequestInit) => Promise<Response>; timeoutMs?: number }>;

class SvixRequestError extends Error {
  constructor(readonly status: number | null) {
    super(status ? `Svix responded ${status}` : "Svix could not be reached");
    this.name = "SvixRequestError";
  }
}

/**
 * Optional managed dispatch through Svix (docs/INTEGRATION_STRATEGY.md §7).
 * The outbox, event catalog, subscriptions, and delivery projection stay in
 * Trestle. Each Trestle endpoint is mirrored as a Svix endpoint (same URL and
 * signing secret, its own channel) in one Svix application per organization;
 * each delivery becomes one Svix message whose eventId is the delivery ID, so
 * a retried hand-off is deduplicated. The Svix message ID is recorded only as
 * a provider reference.
 */
export class SvixWebhookTransport implements WebhookTransport {
  readonly kind = "svix" as const;
  private readonly base: string;
  private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  /** Endpoint state already confirmed in Svix during this isolate's life. */
  private readonly synced = new Map<string, string>();

  constructor(private readonly config: SvixConfig) {
    this.base = (config.serverUrl ?? "https://api.svix.com").replace(/\/+$/u, "");
    this.fetcher = config.fetcher ?? ((url, init) => fetch(url, init));
  }

  private async call(method: string, path: string, body?: unknown, allow404 = false): Promise<Record<string, unknown> | null> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method, redirect: "manual", signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
        headers: { authorization: `Bearer ${this.config.apiKey}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new SvixRequestError(null);
    }
    if (allow404 && response.status === 404) { await response.body?.cancel().catch(() => undefined); return null; }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new SvixRequestError(response.status); }
    return response.status === 204 ? {} : await response.json() as Record<string, unknown>;
  }

  private async ensureEndpoint(request: TransportRequest): Promise<{ app: string; endpoint: string }> {
    const app = encodeURIComponent(request.organizationId);
    const endpoint = encodeURIComponent(request.endpoint.id);
    const signature = `${request.endpoint.url}|${request.secrets[0]}`;
    if (this.synced.get(request.endpoint.id) === signature) return { app, endpoint };
    await this.call("POST", "/api/v1/app/?get_if_exists=true", { name: request.organizationId, uid: request.organizationId });
    const existing = await this.call("GET", `/api/v1/app/${app}/endpoint/${endpoint}/`, undefined, true);
    if (!existing) {
      await this.call("POST", `/api/v1/app/${app}/endpoint/`, { uid: request.endpoint.id, url: request.endpoint.url, secret: request.secrets[0], channels: [request.endpoint.id], description: `Trestle endpoint ${request.endpoint.id}` });
    } else {
      if (existing.url !== request.endpoint.url) await this.call("PUT", `/api/v1/app/${app}/endpoint/${endpoint}/`, { uid: request.endpoint.id, url: request.endpoint.url, channels: [request.endpoint.id], description: `Trestle endpoint ${request.endpoint.id}` });
      const secret = await this.call("GET", `/api/v1/app/${app}/endpoint/${endpoint}/secret/`);
      // A Trestle rotation replaces the Svix secret; Svix keeps its own overlap for the previous one.
      if (secret?.key !== request.secrets[0]) await this.call("POST", `/api/v1/app/${app}/endpoint/${endpoint}/secret/rotate/`, { key: request.secrets[0] });
    }
    this.synced.set(request.endpoint.id, signature);
    return { app, endpoint };
  }

  async send(request: TransportRequest): Promise<TransportResult> {
    try {
      const { app } = await this.ensureEndpoint(request);
      const message = await this.call("POST", `/api/v1/app/${app}/msg/`, { eventType: request.eventName, eventId: request.deliveryId, channels: [request.endpoint.id], payload: request.payload });
      // Accepted for delivery: Svix now owns retries to the endpoint.
      return { responseCode: 202, ...(typeof message?.id === "string" ? { providerReference: message.id } : {}) };
    } catch (error) {
      this.synced.delete(request.endpoint.id);
      if (error instanceof SvixRequestError) return { responseCode: error.status, error };
      return { responseCode: null, error };
    }
  }
}

