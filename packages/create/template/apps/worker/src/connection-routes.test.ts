import { describe, expect, it } from "vitest";

import { hexHmacSha256 } from "./connection-backend.js";
import { allowedIntegrations } from "./connection-routes.js";
import { app } from "./index.js";
import type { WorkerEnvironment } from "./worker-environment.js";

const environment = { DATABASE_URL: "postgres://user:password@127.0.0.1:1/unused", DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "staging" as const };
const nango = { ...environment, TRESTLE_CONNECTION_BACKEND: "nango", NANGO_SECRET_KEY: "nango-secret-key-value-unique-0042", NANGO_WEBHOOK_SECRET: "nango-webhook-signing-key" };
const post = (path: string, body: string, headers: Record<string, string>, env: object) => app.request(path, { method: "POST", body, headers: { "content-type": "application/json", ...headers } }, env);

describe("connection backend routes", () => {
  it("refuses Nango callbacks while the backend or its signing key is not configured", async () => {
    expect((await post("/webhooks/nango", "{}", { "x-nango-hmac-sha256": "0".repeat(64) }, environment)).status).toBe(503);
    expect((await post("/webhooks/nango", "{}", { "x-nango-hmac-sha256": "0".repeat(64) }, { ...nango, NANGO_WEBHOOK_SECRET: undefined })).status).toBe(503);
    expect((await post("/webhooks/nango", "{}", { "x-nango-hmac-sha256": "0".repeat(64) }, { ...nango, TRESTLE_CONNECTION_BACKEND: "local" })).status).toBe(503);
  });

  it("rejects unsigned and wrongly signed callbacks before reading any database", async () => {
    const body = JSON.stringify({ type: "auth", operation: "creation", success: true, connectionId: "c", providerConfigKey: "github", tags: { trestle_attempt_id: "00000000-0000-4000-8000-000000000000" } });
    expect(await (await post("/webhooks/nango", body, {}, nango)).json()).toEqual({ error: "Missing signature" });
    expect((await post("/webhooks/nango", body, { "x-nango-hmac-sha256": await hexHmacSha256(nango.NANGO_SECRET_KEY, body) }, nango)).status).toBe(400);
  });

  it("acknowledges verified callbacks it does not act on", async () => {
    const body = JSON.stringify({ type: "sync", connectionId: "c", providerConfigKey: "github" });
    const response = await post("/webhooks/nango", body, { "x-nango-hmac-sha256": await hexHmacSha256(nango.NANGO_WEBHOOK_SECRET, body) }, nango);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ignored: true });
  });

  it("allows only declared integrations, and none when the list is empty", () => {
    expect(allowedIntegrations(nango as WorkerEnvironment)).toEqual([]);
    expect(allowedIntegrations({ ...nango, TRESTLE_CONNECTION_INTEGRATIONS: " github, slack ,,bad key" } as WorkerEnvironment)).toEqual(["github", "slack"]);
  });

  it("serves the local callback only in local development", async () => {
    expect((await post("/api/dev/connections/callback", "{}", {}, environment)).status).toBe(404);
  });

  it("reports the selected backend in operational health without secrets", async () => {
    const report = await (await app.request("/api/health/operational", {}, nango)).json() as { capabilities: { connectionBackend: Record<string, unknown> } };
    expect(report.capabilities.connectionBackend).toMatchObject({ name: "nango", configured: true, webhookForwarding: "available", inboundVerification: true });
    expect(JSON.stringify(report)).not.toContain(nango.NANGO_SECRET_KEY);
    expect(JSON.stringify(report)).not.toContain(nango.NANGO_WEBHOOK_SECRET);
    const none = await (await app.request("/api/health/operational", {}, environment)).json() as { capabilities: { connectionBackend: Record<string, unknown> } };
    expect(none.capabilities.connectionBackend).toMatchObject({ name: "none", configured: false });
  });

  it("requires an authenticated tenant for Connection management", async () => {
    expect((await app.request("/api/tenant/integrations/connections", {}, nango)).status).toBe(401);
    expect((await post("/api/tenant/integrations/connect-sessions", JSON.stringify({ providerConfigKey: "github" }), {}, nango)).status).toBe(401);
  });
});
