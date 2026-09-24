import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";

const accountId = "0123456789abcdef0123456789abcdef";

async function withApi(handler, work) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    const { status = 200, body = { success: true } } = handler(request);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    return await work(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function runScript(script, environment) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL(script, import.meta.url).pathname], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("Cloudflare preflight verifies token, Pages, and Workers without printing credentials", async () => {
  await withApi(() => ({ body: { success: true, result: { status: "active" } } }), async (base, requests) => {
    const result = await runScript("./cloudflare-preflight.mjs", {
      CLOUDFLARE_API_BASE: base, CLOUDFLARE_API_TOKEN: "test-cloudflare-token", CLOUDFLARE_ACCOUNT_ID: accountId,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests.map(({ path }) => path), [
      "/user/tokens/verify",
      `/accounts/${accountId}/pages/projects?per_page=1`,
      `/accounts/${accountId}/workers/scripts`,
    ]);
    assert.ok(requests.every(({ authorization }) => authorization === "Bearer test-cloudflare-token"));
    assert.doesNotMatch(result.stdout, /test-cloudflare-token/u);
  });
});

test("Cloudflare preflight fails closed on missing Workers access", async () => {
  await withApi((request) => request.url.includes("/workers/scripts") ? { status: 403 } : { body: { success: true, result: { status: "active" } } }, async (base) => {
    const result = await runScript("./cloudflare-preflight.mjs", {
      CLOUDFLARE_API_BASE: base, CLOUDFLARE_API_TOKEN: "test-cloudflare-token", CLOUDFLARE_ACCOUNT_ID: accountId,
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Cloudflare Workers account access rejected.*HTTP 403/u);
    assert.doesNotMatch(result.stderr, /test-cloudflare-token/u);
  });
});

test("Cloudflare preflight rejects a preview URL on another account's Workers subdomain", async () => {
  await withApi((request) => ({ body: { success: true, result: request.url === "/user/tokens/verify" ? { status: "active" } : { subdomain: "different-account" } } }), async (base, requests) => {
    const result = await runScript("./cloudflare-preflight.mjs", {
      CLOUDFLARE_API_BASE: base, CLOUDFLARE_API_TOKEN: "test-cloudflare-token", CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_WORKERS_SUBDOMAIN: "expected-account",
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /subdomain does not match CLOUDFLARE_WORKERS_SUBDOMAIN/u);
    assert.deepEqual(requests.map(({ path }) => path).at(-1), `/accounts/${accountId}/workers/subdomain`);
    assert.doesNotMatch(result.stderr, /test-cloudflare-token/u);
  });
  await withApi((request) => ({ body: { success: true, result: request.url === "/user/tokens/verify" ? { status: "active" } : { subdomain: "expected-account" } } }), async (base) => {
    const result = await runScript("./cloudflare-preflight.mjs", {
      CLOUDFLARE_API_BASE: base, CLOUDFLARE_API_TOKEN: "test-cloudflare-token", CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_WORKERS_SUBDOMAIN: "expected-account",
    });
    assert.equal(result.code, 0, result.stderr);
  });
});

test("Neon preflight verifies access to the exact project without printing credentials", async () => {
  await withApi(() => ({ body: { project: { id: "example-project" } } }), async (base, requests) => {
    const result = await runScript("./neon-preflight.mjs", {
      NEON_API_BASE: base, NEON_API_KEY: "test-neon-key", NEON_PROJECT_ID: "example-project",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests, [{ path: "/projects/example-project", authorization: "Bearer test-neon-key" }]);
    assert.doesNotMatch(result.stdout, /test-neon-key/u);
  });
});

test("Neon preflight rejects an invalid key or mismatched project", async () => {
  await withApi(() => ({ status: 401 }), async (base) => {
    const result = await runScript("./neon-preflight.mjs", {
      NEON_API_BASE: base, NEON_API_KEY: "test-neon-key", NEON_PROJECT_ID: "example-project",
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Neon project access rejected.*HTTP 401/u);
    assert.doesNotMatch(result.stderr, /test-neon-key/u);
  });
  await withApi(() => ({ body: { project: { id: "another-project" } } }), async (base) => {
    const result = await runScript("./neon-preflight.mjs", {
      NEON_API_BASE: base, NEON_API_KEY: "test-neon-key", NEON_PROJECT_ID: "example-project",
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /did not return the configured project/u);
  });
});

function transactionalEnvironment(base, overrides = {}) {
  return {
    TRESTLE_RESEND_API_BASE: base,
    TRESTLE_STRIPE_API_BASE: base,
    TRESTLE_STRIPE_MODE: "test",
    RESEND_API_KEY: "re_test-resend-key",
    STRIPE_SECRET_KEY: "rk_test_stripe_key",
    ...overrides,
  };
}

test("transactional provider preflight verifies read access without exposing credentials", async () => {
  await withApi((request) => request.url === "/domains"
    ? { body: { data: [] } }
    : { body: { object: "list", data: [] } }, async (base, requests) => {
    const result = await runScript("./transactional-provider-preflight.mjs", transactionalEnvironment(base));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests, [
      { path: "/domains", authorization: "Bearer re_test-resend-key" },
      { path: "/v1/prices?limit=1", authorization: "Bearer rk_test_stripe_key" },
    ]);
    assert.doesNotMatch(result.stdout + result.stderr, /re_test-resend-key|rk_test_stripe_key/u);
  });
});

test("transactional provider preflight rejects revoked Resend key before contacting Stripe", async () => {
  await withApi(() => ({ status: 401 }), async (base, requests) => {
    const result = await runScript("./transactional-provider-preflight.mjs", transactionalEnvironment(base));
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Resend rejected the configured credential \(HTTP 401\)/u);
    assert.deepEqual(requests.map(({ path }) => path), ["/domains"]);
    assert.doesNotMatch(result.stdout + result.stderr, /re_test-resend-key|rk_test_stripe_key/u);
  });
});

test("transactional provider preflight rejects unauthorized Stripe read access", async () => {
  await withApi((request) => request.url === "/domains"
    ? { body: { data: [] } }
    : { status: 403 }, async (base) => {
    const result = await runScript("./transactional-provider-preflight.mjs", transactionalEnvironment(base));
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Stripe rejected the configured credential \(HTTP 403\)/u);
    assert.doesNotMatch(result.stdout + result.stderr, /re_test-resend-key|rk_test_stripe_key/u);
  });
});

test("transactional provider preflight enforces test/live mode before network access", async () => {
  await withApi(() => ({ body: { data: [] } }), async (base, requests) => {
    const result = await runScript("./transactional-provider-preflight.mjs", transactionalEnvironment(base, {
      TRESTLE_STRIPE_MODE: "live",
    }));
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /STRIPE_SECRET_KEY must be a live-mode/u);
    assert.equal(requests.length, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /re_test-resend-key|rk_test_stripe_key/u);
  });
});
