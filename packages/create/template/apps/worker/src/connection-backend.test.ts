import { afterEach, describe, expect, it } from "vitest";

import { attemptTag, configuredConnectionBackend, connectionBackend, ConnectionBackendError, ConnectionBackendUnavailable, describeConnectionBackend, hexHmacSha256, normalizeBackendEvent, registerConnectionBackend } from "./connection-backend.js";
import { expireLocalConnection, localConnectionBackend, localSignatureHeader, recordLocalConnection, resetLocalConnections, signLocalCallback } from "./connection-backend-local.js";
import { nangoConnectionBackend, nangoSignatureHeader, nangoTransport } from "./connection-backend-nango.js";
import type { WorkerEnvironment } from "./worker-environment.js";

const base = { DATABASE_URL: "postgres://user:password@127.0.0.1:1/unused", BETTER_AUTH_SECRET: "x".repeat(32), APP_ENV: "local" } as WorkerEnvironment;
const secretKey = "nango-secret-key-value-unique-0042";
const nangoEnv = { ...base, TRESTLE_CONNECTION_BACKEND: "nango", NANGO_SECRET_KEY: secretKey, NANGO_WEBHOOK_SECRET: "nango-webhook-signing-key" } as WorkerEnvironment;
const ref = { providerConfigKey: "github", backendConnectionId: "conn-1" };
const originalFetch = nangoTransport.fetch;

type Call = { url: string; init: RequestInit };
function mockNango(respond: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  nangoTransport.fetch = async (url, init) => { const call = { url, init: init ?? {} }; calls.push(call); return respond(call); };
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);

afterEach(() => { nangoTransport.fetch = originalFetch; resetLocalConnections(); });

describe("connection backend selection", () => {
  it("defaults to none, which disables tenant Connections", () => {
    expect(connectionBackend(base)).toBeNull();
    expect(() => configuredConnectionBackend(base)).toThrow(ConnectionBackendUnavailable);
    expect(describeConnectionBackend(base)).toMatchObject({ name: "none", configured: false });
  });

  it("fails closed for unknown or unregistered backends", () => {
    expect(() => connectionBackend({ ...base, TRESTLE_CONNECTION_BACKEND: "paragon" })).toThrow("Unknown connection backend paragon");
    expect(describeConnectionBackend({ ...base, TRESTLE_CONNECTION_BACKEND: "paragon" })).toMatchObject({ name: "paragon", configured: false });
    expect(() => connectionBackend(nangoEnv)).toThrow("adapter is not installed");
    registerConnectionBackend(nangoConnectionBackend);
    registerConnectionBackend(localConnectionBackend);
    expect(connectionBackend(nangoEnv)?.name).toBe("nango");
    expect(connectionBackend({ ...base, TRESTLE_CONNECTION_BACKEND: "local" })?.name).toBe("local");
  });

  it("treats a selected but unconfigured backend as unavailable", () => {
    registerConnectionBackend(nangoConnectionBackend);
    const unconfigured = { ...base, TRESTLE_CONNECTION_BACKEND: "nango" } as WorkerEnvironment;
    expect(() => configuredConnectionBackend(unconfigured)).toThrow("NANGO_SECRET_KEY is not set");
    expect(() => configuredConnectionBackend({ ...unconfigured, NANGO_SECRET_KEY: "CHANGE_ME" } as WorkerEnvironment)).toThrow(ConnectionBackendUnavailable);
  });
});

describe("local connection backend", () => {
  it("is deterministic, never leaves the process, and scripts credential expiry", async () => {
    const session = await localConnectionBackend.createAuthorizationSession(base, { attemptId: "a1", providerConfigKey: "github" });
    expect(session.token).toBe("local_session_1_a1");
    await expect(localConnectionBackend.completeAuthorization(base, ref)).rejects.toMatchObject({ category: "connection_not_found" });
    recordLocalConnection(ref, "github");
    expect(await localConnectionBackend.completeAuthorization(base, ref)).toEqual({ provider: "github" });
    expect(await localConnectionBackend.proxy(base, ref, { method: "GET", path: "/user" })).toMatchObject({ status: 200, reauthorizationRequired: false });
    expireLocalConnection(ref);
    expect(await localConnectionBackend.proxy(base, ref, { method: "GET", path: "/user" })).toMatchObject({ status: 401, reauthorizationRequired: true });
    expect(await localConnectionBackend.inspect(base, ref)).toMatchObject({ healthy: false });
    await localConnectionBackend.revoke(base, ref);
    await expect(localConnectionBackend.inspect(base, ref)).rejects.toThrow();
  });

  it("verifies its signed callbacks and refuses to run outside local development", async () => {
    const body = JSON.stringify({ type: "auth", operation: "creation", success: true, connectionId: "conn-1", providerConfigKey: "github", tags: { [attemptTag]: "a1" } });
    expect(await localConnectionBackend.verifyInbound(base, body, new Headers({ [localSignatureHeader]: await signLocalCallback(body) }))).toMatchObject({ kind: "authorization", attemptId: "a1" });
    expect(await localConnectionBackend.verifyInbound(base, body, new Headers({ [localSignatureHeader]: "0".repeat(64) }))).toBeNull();
    const staging = { ...base, APP_ENV: "staging" } as WorkerEnvironment;
    expect(localConnectionBackend.describe(staging).configured).toBe(false);
    await expect(localConnectionBackend.createAuthorizationSession(staging, { attemptId: "a1", providerConfigKey: "github" })).rejects.toThrow("runs only in local development");
  });
});

describe("Nango connection backend", () => {
  it("describes configuration without revealing the secret key", () => {
    const status = nangoConnectionBackend.describe(nangoEnv);
    expect(status).toMatchObject({ configured: true, webhookForwarding: "available", inboundVerification: true, detail: "Nango Cloud" });
    expect(JSON.stringify(status)).not.toContain(secretKey);
    const selfHosted = nangoConnectionBackend.describe({ ...nangoEnv, NANGO_HOST: "https://nango.example.test/", NANGO_WEBHOOK_SECRET: undefined } as WorkerEnvironment);
    expect(selfHosted).toMatchObject({ configured: true, webhookForwarding: "unknown", inboundVerification: false });
    expect(selfHosted.detail).toContain("self-hosted at https://nango.example.test");
  });

  it("mints a connect session tagged only with the attempt ID", async () => {
    const calls = mockNango(() => json({ data: { token: "nango_connect_session_abc", connect_link: "https://connect.nango.dev/x", expires_at: "2026-09-27T12:30:00.000Z" } }));
    const session = await nangoConnectionBackend.createAuthorizationSession(nangoEnv, { attemptId: "a1", providerConfigKey: "github" });
    expect(session).toEqual({ token: "nango_connect_session_abc", expiresAt: new Date("2026-09-27T12:30:00.000Z") });
    expect(calls[0]!.url).toBe("https://api.nango.dev/connect/sessions");
    expect(calls[0]!.init.method).toBe("POST");
    expect(header(calls[0]!, "authorization")).toBe(`Bearer ${secretKey}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ tags: { [attemptTag]: "a1" }, allowed_integrations: ["github"] });
  });

  it("maps backend failures to categories without provider bodies", async () => {
    mockNango(() => new Response("upstream said token=abc", { status: 401 }));
    const error = await nangoConnectionBackend.createAuthorizationSession(nangoEnv, { attemptId: "a1", providerConfigKey: "github" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectionBackendError);
    expect((error as ConnectionBackendError).category).toBe("backend_unauthorized");
    expect((error as Error).message).not.toContain("token=abc");
    mockNango(() => { throw new TypeError("network down"); });
    await expect(nangoConnectionBackend.revoke(nangoEnv, ref)).rejects.toMatchObject({ category: "unreachable" });
  });

  it("proxies with Connection-Id and Provider-Config-Key and cannot be redirected by adapter headers", async () => {
    const calls = mockNango(() => json({ login: "octocat" }));
    const response = await nangoConnectionBackend.proxy({ ...nangoEnv, NANGO_HOST: "https://nango.example.test" } as WorkerEnvironment, ref, {
      method: "GET", path: "/user", query: { per_page: "1" }, headers: { Authorization: "Bearer stolen", "Base-Url-Override": "https://evil.test", "Connection-Id": "other", accept: "application/json" },
    });
    expect(response).toEqual({ status: 200, body: { login: "octocat" }, reauthorizationRequired: false });
    expect(calls[0]!.url).toBe("https://nango.example.test/proxy/user?per_page=1");
    expect(header(calls[0]!, "authorization")).toBe(`Bearer ${secretKey}`);
    expect(header(calls[0]!, "connection-id")).toBe("conn-1");
    expect(header(calls[0]!, "provider-config-key")).toBe("github");
    expect(header(calls[0]!, "base-url-override")).toBeNull();
    expect(header(calls[0]!, "accept")).toBe("application/json");
    mockNango(() => json({ message: "Bad credentials" }, 401));
    expect(await nangoConnectionBackend.proxy(nangoEnv, ref, { method: "GET", path: "/user" })).toMatchObject({ status: 401, reauthorizationRequired: true });
    await expect(nangoConnectionBackend.proxy(nangoEnv, ref, { method: "GET", path: "//evil.test/x" })).rejects.toMatchObject({ category: "invalid_path" });
  });

  it("confirms, inspects, and deletes connections through credential-free endpoints", async () => {
    const calls = mockNango((call) => call.init.method === "DELETE" ? new Response(null, { status: 204 }) : json({ connections: [{ connection_id: "conn-1", provider_config_key: "github", provider: "github", errors: [{ type: "auth", log_id: "l1" }] }] }));
    expect(await nangoConnectionBackend.completeAuthorization(nangoEnv, ref)).toEqual({ provider: "github" });
    expect(calls[0]!.url).toBe("https://api.nango.dev/connection?connectionId=conn-1");
    expect(await nangoConnectionBackend.inspect(nangoEnv, ref)).toEqual({ provider: "github", scopes: null, healthy: false });
    await nangoConnectionBackend.revoke(nangoEnv, ref);
    expect(calls.at(-1)).toMatchObject({ url: "https://api.nango.dev/connection/conn-1?provider_config_key=github", init: { method: "DELETE" } });
    await expect(nangoConnectionBackend.completeAuthorization(nangoEnv, { ...ref, providerConfigKey: "slack" })).rejects.toMatchObject({ category: "connection_not_found" });
    mockNango(() => new Response(null, { status: 404 }));
    await expect(nangoConnectionBackend.revoke(nangoEnv, ref)).resolves.toBeUndefined();
  });

  it("verifies X-Nango-Hmac-Sha256 with the webhook signing key, not the secret key", async () => {
    const body = JSON.stringify({ type: "auth", operation: "creation", success: true, connectionId: "conn-1", providerConfigKey: "github", provider: "github", tags: { [attemptTag]: "a1", organization_id: "org-from-tag" } });
    const valid = await hexHmacSha256("nango-webhook-signing-key", body);
    expect(await nangoConnectionBackend.verifyInbound(nangoEnv, body, new Headers({ [nangoSignatureHeader]: valid }))).toEqual({ kind: "authorization", success: true, attemptId: "a1", providerConfigKey: "github", backendConnectionId: "conn-1", provider: "github", errorCategory: null });
    expect(await nangoConnectionBackend.verifyInbound(nangoEnv, body, new Headers({ [nangoSignatureHeader]: await hexHmacSha256(secretKey, body) }))).toBeNull();
    expect(await nangoConnectionBackend.verifyInbound(nangoEnv, `${body} `, new Headers({ [nangoSignatureHeader]: valid }))).toBeNull();
    expect(await nangoConnectionBackend.verifyInbound(nangoEnv, body, new Headers({ "x-nango-signature": valid }))).toBeNull();
    await expect(nangoConnectionBackend.verifyInbound({ ...nangoEnv, NANGO_WEBHOOK_SECRET: undefined } as WorkerEnvironment, body, new Headers({ [nangoSignatureHeader]: valid }))).rejects.toThrow(ConnectionBackendUnavailable);
  });
});

describe("backend callback normalization", () => {
  it("maps refresh failures to credential failures and ignores other webhook types", () => {
    expect(normalizeBackendEvent({ type: "auth", operation: "refresh", success: false, connectionId: "conn-1", providerConfigKey: "github", error: { type: "refresh_token_external_error", description: "secret" } }))
      .toEqual({ kind: "credential_failed", providerConfigKey: "github", backendConnectionId: "conn-1", errorCategory: "refresh_token_external_error" });
    expect(normalizeBackendEvent({ type: "sync", connectionId: "conn-1" })).toEqual({ kind: "ignored", type: "sync" });
    expect(normalizeBackendEvent({ type: "auth", operation: "creation", success: false, connectionId: "conn-1", providerConfigKey: "github", error: { type: "<script>" } })).toMatchObject({ success: false, errorCategory: "unknown", attemptId: null });
    expect(normalizeBackendEvent({ type: "auth", operation: "creation" })).toBeNull();
  });
});
