import { execFile } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const servers: Server[] = [];
const smokeScript = path.resolve("packages/create/template/scripts/smoke.mjs");

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to resolve test server address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

async function surfaces(webhookStatus = 400, operational = { status: "ok", environment: "staging", capabilities: { database: { configured: true }, email: { mode: "resend", configured: true, stagingProtected: true }, billing: { mode: "test", configured: true } } }): Promise<{ apiURL: string; appURL: string; siteURL: string }> {
  let appURL = "";
  const apiURL = await listen((request, response) => {
    response.setHeader("access-control-allow-origin", appURL);
    if (request.url === "/api/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", service: "smoke-worker" }));
      return;
    }
    if (request.url === "/api/health/operational") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(operational));
      return;
    }
    if (request.url === "/api/me" || request.url === "/api/billing/subscription") {
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }
    if (request.url === "/api/webhooks/resend" || request.url === "/webhooks/stripe") {
      response.statusCode = webhookStatus;
      response.end("rejected");
      return;
    }
    response.statusCode = 404;
    response.end("missing");
  });
  appURL = await listen((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>App</title>");
  });
  const siteURL = await listen((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<a href="${appURL}/sign-in">Sign in</a><a href="${appURL}/sign-up">Sign up</a>`);
  });
  return { apiURL, appURL, siteURL };
}

describe("deployed smoke gate", () => {
  it("checks health, CORS, anonymous authorization, webhook configuration, app routes, and site handoff", async () => {
    const urls = await surfaces();
    const result = await execute(process.execPath, [smokeScript], { env: { ...process.env, TRESTLE_DEPLOY_ENV: "staging", API_URL: urls.apiURL, APP_URL: urls.appURL, SITE_URL: urls.siteURL } });
    expect(result.stdout).toContain("Smoke passed");
  });

  it("fails when provider webhooks are not configured to reject unsigned traffic", async () => {
    const urls = await surfaces(503);
    await expect(execute(process.execPath, [smokeScript], { env: { ...process.env, TRESTLE_DEPLOY_ENV: "staging", API_URL: urls.apiURL, APP_URL: urls.appURL, SITE_URL: urls.siteURL } })).rejects.toMatchObject({ stderr: expect.stringContaining("Unsigned Resend webhook was not rejected as configured") });
  });

  it("fails when the deployed Worker reports the wrong environment or provider mode", async () => {
    const urls = await surfaces(400, { status: "ok", environment: "preview", capabilities: { database: { configured: true }, email: { mode: "resend", configured: true, stagingProtected: true }, billing: { mode: "test", configured: true } } });
    await expect(execute(process.execPath, [smokeScript], { env: { ...process.env, TRESTLE_DEPLOY_ENV: "staging", API_URL: urls.apiURL, APP_URL: urls.appURL, SITE_URL: urls.siteURL } })).rejects.toMatchObject({ stderr: expect.stringContaining("operational environment") });
  });

  it.each([
    { field: "database", override: { database: { configured: false } }, expected: "database binding" },
    { field: "email", override: { email: { mode: "resend", configured: false, stagingProtected: true } }, expected: "Resend email" },
    { field: "recipient", override: { email: { mode: "resend", configured: true, stagingProtected: false } }, expected: "recipient protection" },
    { field: "billing", override: { billing: { mode: "live", configured: true } }, expected: "Stripe test" },
  ])("fails when operational $field is unsafe", async ({ override, expected }) => {
    const capabilities = { database: { configured: true }, email: { mode: "resend", configured: true, stagingProtected: true }, billing: { mode: "test", configured: true }, ...override };
    const urls = await surfaces(400, { status: "ok", environment: "staging", capabilities });
    await expect(execute(process.execPath, [smokeScript], { env: { ...process.env, TRESTLE_DEPLOY_ENV: "staging", API_URL: urls.apiURL, APP_URL: urls.appURL, SITE_URL: urls.siteURL } })).rejects.toMatchObject({ stderr: expect.stringContaining(expected) });
  });
});
