import { attemptTag, ConnectionBackendError, ConnectionBackendUnavailable, normalizeBackendEvent, verifyHexHmacSha256, type BackendConnectionRef, type ConnectionBackend } from "./connection-backend.js";
import type { WorkerEnvironment } from "./worker-environment.js";

/**
 * Nango as the connection backend, over its REST API (no SDK). The developer
 * brings their own Nango account: NANGO_SECRET_KEY is the only required
 * secret, one per Trestle environment. NANGO_HOST points at a self-hosted
 * instance. NANGO_WEBHOOK_SECRET is Nango's webhook signing key (Environment
 * Settings > Webhooks), which is distinct from the secret key; without it the
 * inbound route refuses callbacks. Nango holds provider tokens; nothing here
 * reads, logs, or returns them.
 */
export type NangoEnvironment = Readonly<{ NANGO_SECRET_KEY?: string; NANGO_HOST?: string; NANGO_WEBHOOK_SECRET?: string }>;
export const nangoCloudHost = "https://api.nango.dev";
/** Nango signs each webhook body with HMAC-SHA256 (hex) under the webhook signing key. */
export const nangoSignatureHeader = "x-nango-hmac-sha256";

const nango = (environment: WorkerEnvironment) => environment as WorkerEnvironment & NangoEnvironment;
const host = (environment: WorkerEnvironment) => (nango(environment).NANGO_HOST?.trim() || nangoCloudHost).replace(/\/$/u, "");
const configured = (value: string | undefined) => Boolean(value?.trim() && value.trim() !== "CHANGE_ME");

/** Injectable for tests; the Worker's global fetch otherwise. */
export const nangoTransport = { fetch: (input: string, init?: RequestInit) => fetch(input, init) };

async function call(environment: WorkerEnvironment, method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
  const secret = nango(environment).NANGO_SECRET_KEY;
  if (!configured(secret)) throw new ConnectionBackendUnavailable("NANGO_SECRET_KEY is not set");
  let response: Response;
  try {
    response = await nangoTransport.fetch(`${host(environment)}${path}`, {
      method,
      headers: { ...init.headers, authorization: `Bearer ${secret!.trim()}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new ConnectionBackendError("unreachable");
  }
  return response;
}

async function expectOk(response: Response, category: string): Promise<Response> {
  if (response.ok) return response;
  await response.body?.cancel();
  throw new ConnectionBackendError(response.status === 401 || response.status === 403 ? "backend_unauthorized" : category, response.status);
}

/** Connection metadata through the list endpoint, which never includes credentials. */
async function findConnection(environment: WorkerEnvironment, ref: BackendConnectionRef): Promise<{ provider: string | null; errors: unknown[] } | null> {
  const response = await expectOk(await call(environment, "GET", `/connection?connectionId=${encodeURIComponent(ref.backendConnectionId)}`), "lookup_failed");
  const body = await response.json() as { connections?: Array<{ connection_id?: unknown; provider_config_key?: unknown; provider?: unknown; errors?: unknown }> };
  const match = (body.connections ?? []).find((item) => item.connection_id === ref.backendConnectionId && item.provider_config_key === ref.providerConfigKey);
  return match ? { provider: typeof match.provider === "string" ? match.provider : null, errors: Array.isArray(match.errors) ? match.errors : [] } : null;
}

/** Adapter headers never replace the backend's authority or redirect the call to another base URL. */
const reservedHeaders = new Set(["authorization", "connection-id", "provider-config-key", "base-url-override", "host", "content-type"]);
function forwardableHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reservedHeaders.has(name.toLowerCase())).map(([name, value]) => [name.toLowerCase(), value]));
}

export const nangoConnectionBackend: ConnectionBackend = {
  name: "nango",
  describe: (environment) => {
    const settings = nango(environment);
    const selfHosted = Boolean(settings.NANGO_HOST?.trim()) && host(environment) !== nangoCloudHost;
    if (!configured(settings.NANGO_SECRET_KEY)) return { configured: false, detail: "NANGO_SECRET_KEY is not set; tenant Connections are unavailable", webhookForwarding: "unknown", inboundVerification: false };
    return {
      configured: true,
      detail: `Nango ${selfHosted ? `self-hosted at ${host(environment)}` : "Cloud"}${configured(settings.NANGO_WEBHOOK_SECRET) ? "" : "; NANGO_WEBHOOK_SECRET is not set, so connection callbacks are refused"}`,
      // Free self-hosted Nango does not forward provider webhooks; the plan is not visible from here.
      webhookForwarding: selfHosted ? "unknown" : "available",
      inboundVerification: configured(settings.NANGO_WEBHOOK_SECRET),
    };
  },
  createAuthorizationSession: async (environment, input) => {
    // Only the attempt ID travels as a tag. The organization comes back from the persisted attempt, never from Nango.
    const response = await expectOk(await call(environment, "POST", "/connect/sessions", { body: { tags: { [attemptTag]: input.attemptId }, allowed_integrations: [input.providerConfigKey] } }), "session_failed");
    const body = await response.json() as { data?: { token?: unknown; expires_at?: unknown } };
    if (typeof body.data?.token !== "string" || !body.data.token) throw new ConnectionBackendError("session_malformed");
    const expiresAt = typeof body.data.expires_at === "string" ? new Date(body.data.expires_at) : new Date(Date.now() + 30 * 60_000);
    return { token: body.data.token, expiresAt: Number.isNaN(expiresAt.getTime()) ? new Date(Date.now() + 30 * 60_000) : expiresAt };
  },
  completeAuthorization: async (environment, ref) => {
    const found = await findConnection(environment, ref);
    if (!found) throw new ConnectionBackendError("connection_not_found");
    return { provider: found.provider };
  },
  proxy: async (environment, ref, request) => {
    if (!request.path.startsWith("/") || request.path.startsWith("//") || /[\r\n]/u.test(request.path)) throw new ConnectionBackendError("invalid_path");
    const query = request.query && Object.keys(request.query).length ? `?${new URLSearchParams(request.query).toString()}` : "";
    const response = await call(environment, request.method, `/proxy${request.path}${query}`, {
      headers: { ...forwardableHeaders(request.headers), "connection-id": ref.backendConnectionId, "provider-config-key": ref.providerConfigKey },
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    const text = await response.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* a non-JSON provider body stays text */ }
    return { status: response.status, body, reauthorizationRequired: response.status === 401 };
  },
  inspect: async (environment, ref) => {
    const found = await findConnection(environment, ref);
    if (!found) throw new ConnectionBackendError("connection_not_found");
    // Nango reports auth errors per connection; granted scopes are not exposed without reading credentials.
    return { provider: found.provider, scopes: null, healthy: !found.errors.some((error) => (error as { type?: unknown })?.type === "auth") };
  },
  revoke: async (environment, ref) => {
    const response = await call(environment, "DELETE", `/connection/${encodeURIComponent(ref.backendConnectionId)}?provider_config_key=${encodeURIComponent(ref.providerConfigKey)}`);
    if (response.status === 404) { await response.body?.cancel(); return; }
    await expectOk(response, "revoke_failed");
    await response.body?.cancel();
  },
  verifyInbound: async (environment, rawBody, headers) => {
    const secret = nango(environment).NANGO_WEBHOOK_SECRET;
    if (!configured(secret)) throw new ConnectionBackendUnavailable("NANGO_WEBHOOK_SECRET is not set");
    // X-Nango-Signature (legacy, plain SHA-256 of secret+body) is deliberately not accepted.
    if (!await verifyHexHmacSha256(secret!.trim(), rawBody, headers.get(nangoSignatureHeader))) return null;
    try { return normalizeBackendEvent(JSON.parse(rawBody)); } catch { return null; }
  },
};
