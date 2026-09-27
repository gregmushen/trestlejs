import { ConnectionBackendError, hexHmacSha256, normalizeBackendEvent, verifyHexHmacSha256, type BackendConnectionRef, type ConnectionBackend } from "./connection-backend.js";
import type { WorkerEnvironment } from "./worker-environment.js";

/**
 * A deterministic stand-in for a hosted connection backend, for local
 * development and tests. It never touches the network and holds no real
 * credential: "connections" are in-memory records. Callbacks use the Nango
 * body shape, signed with a fixed local key, so the same inbound handler is
 * exercised. It refuses to run outside APP_ENV=local.
 */
export const localCallbackSigningKey = "trestle-local-connection-backend";
export const localSignatureHeader = "x-trestle-local-signature";

type LocalConnection = { provider: string; expired: boolean; revoked: boolean };
const connections = new Map<string, LocalConnection>();
const key = (ref: BackendConnectionRef) => `${ref.providerConfigKey}\u0000${ref.backendConnectionId}`;
const isLocal = (environment: WorkerEnvironment) => !environment.APP_ENV || environment.APP_ENV === "local";
let sessions = 0;

function requireLocal(environment: WorkerEnvironment): void {
  if (!isLocal(environment)) throw new Error("The local connection backend runs only in local development");
}

function existing(ref: BackendConnectionRef): LocalConnection {
  const connection = connections.get(key(ref));
  if (!connection || connection.revoked) throw new ConnectionBackendError("connection_not_found");
  return connection;
}

/** Local scripting: what a completed hosted flow would leave behind at the backend. */
export function recordLocalConnection(ref: BackendConnectionRef, provider = "local"): void {
  connections.set(key(ref), { provider, expired: false, revoked: false });
}

/** Local scripting: the provider credential stops working (the proxy then answers 401). */
export function expireLocalConnection(ref: BackendConnectionRef): void {
  existing(ref).expired = true;
}

export function resetLocalConnections(): void {
  connections.clear();
  sessions = 0;
}

/** Signs a local callback body exactly as the inbound route verifies it. */
export async function signLocalCallback(rawBody: string): Promise<string> {
  return await hexHmacSha256(localCallbackSigningKey, rawBody);
}

export const localConnectionBackend: ConnectionBackend = {
  name: "local",
  describe: (environment) => isLocal(environment)
    ? { configured: true, detail: "deterministic local backend; no provider is contacted", webhookForwarding: "unavailable", inboundVerification: true }
    : { configured: false, detail: "the local connection backend is for local development only", webhookForwarding: "unavailable", inboundVerification: false },
  createAuthorizationSession: async (environment, input) => {
    requireLocal(environment);
    sessions += 1;
    return { token: `local_session_${sessions}_${input.attemptId}`, expiresAt: new Date(Date.now() + 30 * 60_000) };
  },
  completeAuthorization: async (environment, ref) => {
    requireLocal(environment);
    return { provider: existing(ref).provider };
  },
  proxy: async (environment, ref, request) => {
    requireLocal(environment);
    const connection = existing(ref);
    if (connection.expired) return { status: 401, body: { error: "expired_credential" }, reauthorizationRequired: true };
    return { status: 200, body: { local: true, method: request.method, path: request.path }, reauthorizationRequired: false };
  },
  inspect: async (environment, ref) => {
    requireLocal(environment);
    const connection = existing(ref);
    return { provider: connection.provider, scopes: [], healthy: !connection.expired };
  },
  revoke: async (environment, ref) => {
    requireLocal(environment);
    const connection = connections.get(key(ref));
    if (connection) connection.revoked = true;
  },
  verifyInbound: async (environment, rawBody, headers) => {
    requireLocal(environment);
    if (!await verifyHexHmacSha256(localCallbackSigningKey, rawBody, headers.get(localSignatureHeader))) return null;
    try { return normalizeBackendEvent(JSON.parse(rawBody)); } catch { return null; }
  },
};
