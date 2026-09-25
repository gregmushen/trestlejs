import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";

const ref = "a".repeat(40);
const token = "test-github-token";
const repository = "example/project";

async function withApi(work) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let rawBody = "";
    for await (const chunk of request) rawBody += chunk;
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: rawBody ? JSON.parse(rawBody) : undefined });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.method === "GET" ? [{ id: 42 }] : request.url.endsWith("/deployments") ? { id: 42 } : {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    return await work(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function runScript(args, base = "http://127.0.0.1:1") {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("./github-deployment.mjs", import.meta.url).pathname, ...args], {
      env: { ...process.env, GITHUB_API_URL: base, GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: "123" },
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

for (const [environment, transient, production, description, statusDescription, autoInactive] of [
  ["preview-pr-7", true, false, "Trestle isolated pull-request preview", "Preview smoke gate passed", true],
  ["staging", false, false, "Trestle staging deployment", "Staging smoke gate passed", true],
  ["production", false, true, "Trestle production deployment", "Production smoke gate passed", false],
]) {
  test(`records ${environment} with correct GitHub deployment semantics`, async () => {
    await withApi(async (base, requests) => {
      const result = await runScript(["create", environment, ref, "https://example.test/app"], base);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Recorded .* deployment 42/u);
      assert.doesNotMatch(result.stdout + result.stderr, /test-github-token/u);
      assert.equal(requests.length, 2);
      assert.ok(requests.every(({ authorization }) => authorization === `Bearer ${token}`));
      assert.deepEqual(requests[0], {
        method: "POST", path: `/repos/${repository}/deployments`, authorization: `Bearer ${token}`,
        body: { ref, environment, auto_merge: false, required_contexts: [], transient_environment: transient, production_environment: production, description },
      });
      assert.deepEqual(requests[1], {
        method: "POST", path: `/repos/${repository}/deployments/42/statuses`, authorization: `Bearer ${token}`,
        body: { state: "success", environment_url: "https://example.test/app", log_url: `https://github.com/${repository}/actions/runs/123`, description: statusDescription, auto_inactive: autoInactive },
      });
    });
  });
}

test("only a pull-request preview may be deactivated", async () => {
  for (const environment of ["staging", "production"]) {
    const result = await runScript(["deactivate", environment]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /only pull-request preview deployments may be deactivated/u);
    assert.doesNotMatch(result.stderr, /test-github-token/u);
  }
  await withApi(async (base, requests) => {
    const result = await runScript(["deactivate", "preview-pr-7"], base);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests.map(({ method, path }) => [method, path]), [
      ["GET", `/repos/${repository}/deployments?environment=preview-pr-7&per_page=100`],
      ["POST", `/repos/${repository}/deployments/42/statuses`],
    ]);
    assert.deepEqual(requests[1].body, {
      state: "inactive", log_url: `https://github.com/${repository}/actions/runs/123`,
      description: "Preview resources removed", auto_inactive: false,
    });
  });
});

test("rejects unknown environments, refs, and non-HTTPS URLs before contacting GitHub", async () => {
  for (const args of [
    ["create", "other", ref, "https://example.test"],
    ["create", "preview-pr-0", ref, "https://example.test"],
    ["create", "staging", "main", "https://example.test"],
    ["create", "production", ref, "http://example.test"],
  ]) {
    const result = await runScript(args);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.stderr, /test-github-token/u);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED/u);
  }
});
