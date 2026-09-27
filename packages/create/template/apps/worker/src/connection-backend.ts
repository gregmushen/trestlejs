import type { WorkerEnvironment } from "./worker-environment.js";

/**
 * Who holds a tenant Connection's provider credentials and performs the
 * authorization flow, token refresh, and authenticated provider calls.
 * Trestle still owns the Connection: its tenant binding, lifecycle state,
 * generation, permissions, and audit. Selected per environment by
 * TRESTLE_CONNECTION_BACKEND, following the job runtime pattern: registered
 * adapters, explicit selection, and fail-closed resolution.
 */
export type ConnectionBackendName = "none" | "local" | "nango";
export const connectionBackendNames = ["none", "local", "nango"] as const;

/** The only credential capability adapter code receives: usable solely through the backend's `proxy`. */
export type BackendConnectionRef = Readonly<{ providerConfigKey: string; backendConnectionId: string }>;

export type ConnectionBackendStatus = Readonly<{
  configured: boolean;
  /** Safe for Doctor, the health route, and the admin; never a secret. */
  detail: string;
  /** Whether the backend can forward provider webhooks; `unknown` when it depends on the backend's plan. */
  webhookForwarding: "available" | "unavailable" | "unknown";
  /** Whether signed backend callbacks can be verified in this environment. */
  inboundVerification: boolean;
}>;

export type ProxyRequest = Readonly<{ method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown }>;
export type ProxyResponse = Readonly<{ status: number; body: unknown; reauthorizationRequired: boolean }>;

/** A verified backend callback, normalized. Tags and IDs in it are data to check against persisted state, never tenant authority. */
export type BackendEvent =
  | Readonly<{ kind: "authorization"; success: boolean; attemptId: string | null; providerConfigKey: string; backendConnectionId: string; provider: string | null; errorCategory: string | null }>
  | Readonly<{ kind: "credential_failed"; providerConfigKey: string; backendConnectionId: string; errorCategory: string }>
  | Readonly<{ kind: "ignored"; type: string }>;

export type ConnectionBackend = Readonly<{
  name: Exclude<ConnectionBackendName, "none">;
  describe(environment: WorkerEnvironment): ConnectionBackendStatus;
  /** A short-lived session for the customer connect UI. Only the token reaches the browser. */
  createAuthorizationSession(environment: WorkerEnvironment, input: Readonly<{ attemptId: string; providerConfigKey: string }>): Promise<{ token: string; expiresAt: Date }>;
  /** Confirms the backend really holds the reported connection before it is bound. */
  completeAuthorization(environment: WorkerEnvironment, ref: BackendConnectionRef): Promise<{ provider: string | null }>;
  proxy(environment: WorkerEnvironment, ref: BackendConnectionRef, request: ProxyRequest): Promise<ProxyResponse>;
  /** Provider identity and granted scopes, as far as the backend reports them without credentials. */
  inspect(environment: WorkerEnvironment, ref: BackendConnectionRef): Promise<{ provider: string | null; scopes: string[] | null; healthy: boolean }>;
  revoke(environment: WorkerEnvironment, ref: BackendConnectionRef): Promise<void>;
  /** Null when the signature is missing or wrong. Throws `ConnectionBackendUnavailable` when verification is not configured. */
  verifyInbound(environment: WorkerEnvironment, rawBody: string, headers: Headers): Promise<BackendEvent | null>;
}>;

export class ConnectionBackendUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionBackendUnavailable";
  }
}

/** Backend failures carry only a category, never a provider response body or credential. */
export class ConnectionBackendError extends Error {
  constructor(readonly category: string, readonly status?: number) {
    super(`Connection backend request failed (${category}${status ? `, HTTP ${status}` : ""})`);
    this.name = "ConnectionBackendError";
  }
}

/** The tag that carries the attempt ID through the backend's hosted flow. */
export const attemptTag = "trestle_attempt_id";
/** How long a connect session and its attempt stay usable. */
export const authorizationAttemptTtlMs = 30 * 60_000;

const adapters = new Map<Exclude<ConnectionBackendName, "none">, ConnectionBackend>();

/** First-party backends register at Worker startup; a selected but unregistered backend fails closed. */
export function registerConnectionBackend(adapter: ConnectionBackend): void {
  adapters.set(adapter.name, adapter);
}

/**
 * The backend selected by TRESTLE_CONNECTION_BACKEND. `none` (the default)
 * returns null: tenant Connections are disabled. An unknown or unregistered
 * name throws.
 */
export function connectionBackend(environment: WorkerEnvironment): ConnectionBackend | null {
  const name = (environment.TRESTLE_CONNECTION_BACKEND ?? "none") as ConnectionBackendName;
  if (!connectionBackendNames.includes(name)) throw new Error(`Unknown connection backend ${String(environment.TRESTLE_CONNECTION_BACKEND)}`);
  if (name === "none") return null;
  const adapter = adapters.get(name);
  if (!adapter) throw new Error(`Connection backend ${name} is selected but its adapter is not installed`);
  return adapter;
}

/** The selected backend, only when it is also configured; otherwise a `ConnectionBackendUnavailable`. */
export function configuredConnectionBackend(environment: WorkerEnvironment): ConnectionBackend {
  const backend = connectionBackend(environment);
  if (!backend) throw new ConnectionBackendUnavailable("Tenant Connections are disabled (TRESTLE_CONNECTION_BACKEND=none)");
  const status = backend.describe(environment);
  if (!status.configured) throw new ConnectionBackendUnavailable(status.detail);
  return backend;
}

/** For the operational health route: never throws, never includes secrets. */
export function describeConnectionBackend(environment: WorkerEnvironment): { name: string } & ConnectionBackendStatus {
  try {
    const backend = connectionBackend(environment);
    if (!backend) return { name: "none", configured: false, detail: "tenant Connections are disabled", webhookForwarding: "unavailable", inboundVerification: false };
    return { name: backend.name, ...backend.describe(environment) };
  } catch (error) {
    return { name: environment.TRESTLE_CONNECTION_BACKEND ?? "none", configured: false, detail: error instanceof Error ? error.message : "unavailable", webhookForwarding: "unavailable", inboundVerification: false };
  }
}

const encoder = new TextEncoder();

/** Hex HMAC-SHA256 of the raw body, compared in constant time. */
export async function verifyHexHmacSha256(secret: string, rawBody: string, supplied: string | null): Promise<boolean> {
  if (!supplied || !/^[0-9a-f]{64}$/iu.test(supplied)) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  const given = supplied.toLowerCase();
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected[index]! ^ Number.parseInt(given.slice(index * 2, index * 2 + 2), 16);
  return difference === 0;
}

export async function hexHmacSha256(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const errorCategory = (value: unknown): string => {
  const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
  return typeof type === "string" && /^[A-Za-z0-9_.:-]{1,64}$/u.test(type) ? type : "unknown";
};

/**
 * Normalizes a Nango-shaped auth callback body (Nango and the local backend
 * share it). Anything unrecognized is `ignored`, not an error.
 */
export function normalizeBackendEvent(body: unknown): BackendEvent | null {
  if (!body || typeof body !== "object") return null;
  const event = body as Record<string, unknown>;
  if (event.type !== "auth") return { kind: "ignored", type: typeof event.type === "string" ? event.type.slice(0, 32) : "unknown" };
  const connectionId = event.connectionId;
  const providerConfigKey = event.providerConfigKey;
  if (typeof connectionId !== "string" || !connectionId || connectionId.length > 255 || typeof providerConfigKey !== "string" || !providerConfigKey || providerConfigKey.length > 255) return null;
  const tags = event.tags && typeof event.tags === "object" ? event.tags as Record<string, unknown> : {};
  const provider = typeof event.provider === "string" ? event.provider.slice(0, 100) : null;
  if (event.operation === "creation" || event.operation === "override") {
    const attemptId = typeof tags[attemptTag] === "string" ? tags[attemptTag] as string : null;
    return { kind: "authorization", success: event.success === true, attemptId, providerConfigKey, backendConnectionId: connectionId, provider, errorCategory: event.success === true ? null : errorCategory(event.error) };
  }
  if (event.operation === "refresh" && event.success === false) return { kind: "credential_failed", providerConfigKey, backendConnectionId: connectionId, errorCategory: errorCategory(event.error) };
  return { kind: "ignored", type: `auth.${typeof event.operation === "string" ? event.operation.slice(0, 32) : "unknown"}` };
}
