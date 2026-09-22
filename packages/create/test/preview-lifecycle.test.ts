import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const servers: Array<ReturnType<typeof createServer>> = [];
const template = path.resolve("packages/create/template");

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function run(script: string, arguments_: string[], environment: NodeJS.ProcessEnv = {}) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(template, "scripts", script), ...arguments_], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function api(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("preview lifecycle", () => {
  it("derives isolated, deterministic URLs and provider-safe names", async () => {
    const result = await run("preview-context.mjs", ["--project", "clearclose", "--pr", "42", "--workers-subdomain", "greg", "--format", "github"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("worker_name=clearclose-worker-pr-42");
    expect(result.stdout).toContain("api_url=https://clearclose-worker-pr-42.greg.workers.dev");
    expect(result.stdout).toContain("app_url=https://clearclose-app-pr-42.pages.dev");
    expect(result.stdout).toContain("site_url=https://clearclose-site-pr-42.pages.dev");
  });

  it("rejects injection-shaped preview inputs", async () => {
    const result = await run("preview-context.mjs", ["--project", "safe;echo-pwned", "--pr", "42", "--workers-subdomain", "greg"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DNS-safe");
    expect(result.stdout).toBe("");
  });

  it("bounds long provider resource names and keeps them deterministic", async () => {
    const project = `a${"b".repeat(90)}`;
    const first = await run("preview-context.mjs", ["--project", project, "--pr", "123", "--workers-subdomain", "greg"]);
    const second = await run("preview-context.mjs", ["--project", project, "--pr", "123", "--workers-subdomain", "greg"]);
    expect(first).toMatchObject({ code: 0, stderr: "" });
    expect(first.stdout).toBe(second.stdout);
    const context = JSON.parse(first.stdout) as { workerName: string; appProject: string; siteProject: string };
    expect(context.workerName.length).toBeLessThanOrEqual(63);
    expect(context.appProject.length).toBeLessThanOrEqual(63);
    expect(context.siteProject.length).toBeLessThanOrEqual(63);
    expect(new Set([context.workerName, context.appProject, context.siteProject]).size).toBe(3);
  });

  it("creates a missing Pages project without leaking the API token", async () => {
    const requests: Array<{ method: string; url: string; authorization?: string; body: string }> = [];
    const base = await api((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        requests.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization, body });
        response.statusCode = request.method === "GET" ? 404 : 200;
        response.end('{"success":true}');
      });
    });
    const result = await run("cloudflare-pages.mjs", ["ensure", "clearclose-app-pr-42"], {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "top-secret",
      CLOUDFLARE_API_BASE: base,
    });
    expect(result).toMatchObject({ code: 0, stdout: "Created clearclose-app-pr-42\n", stderr: "" });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "POST"]);
    expect(requests[1]?.body).toBe('{"name":"clearclose-app-pr-42","production_branch":"main"}');
    expect(requests.every(({ authorization }) => authorization === "Bearer top-secret")).toBe(true);
    expect(`${result.stdout}${result.stderr}`).not.toContain("top-secret");
  });

  it("treats deletion of an already absent Pages project as success", async () => {
    const base = await api((_request, response) => { response.statusCode = 404; response.end('{"success":false}'); });
    const result = await run("cloudflare-pages.mjs", ["delete", "clearclose-app-pr-42"], {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "top-secret",
      CLOUDFLARE_API_BASE: base,
    });
    expect(result).toMatchObject({ code: 0, stdout: "clearclose-app-pr-42 already absent\n", stderr: "" });
  });

  it("deletes the isolated Worker through an idempotent authenticated request", async () => {
    const requests: Array<{ method: string; url: string; authorization?: string }> = [];
    const base = await api((request, response) => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization });
      response.statusCode = 200;
      response.end('{"success":true}');
    });
    const result = await run("cloudflare-worker.mjs", ["delete", "clearclose-worker-pr-42"], {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "top-secret",
      CLOUDFLARE_API_BASE: base,
    });
    expect(result).toMatchObject({ code: 0, stdout: "Deleted clearclose-worker-pr-42\n", stderr: "" });
    expect(requests).toEqual([{ method: "DELETE", url: "/accounts/account/workers/scripts/clearclose-worker-pr-42", authorization: "Bearer top-secret" }]);
  });

  it("fails closed on provider errors and sanitizes the response", async () => {
    const base = await api((_request, response) => { response.statusCode = 500; response.end('top-secret provider body'); });
    const result = await run("cloudflare-pages.mjs", ["ensure", "clearclose-app-pr-42"], {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "top-secret",
      CLOUDFLARE_API_BASE: base,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("HTTP 500");
    expect(result.stderr).not.toContain("top-secret");
  });

  it("publishes a URL-bearing GitHub Deployment after the smoke gate", async () => {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const base = await api((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        requests.push({ method: request.method ?? "", url: request.url ?? "", body });
        response.statusCode = 201;
        response.end(request.url?.endsWith("/deployments") ? '{"id":73}' : '{"id":91}');
      });
    });
    const sha = "a".repeat(40);
    const result = await run("github-deployment.mjs", ["create", "preview-pr-42", sha, "https://clearclose-app-pr-42.pages.dev"], {
      GITHUB_API_URL: base,
      GITHUB_REPOSITORY: "greg/clearclose",
      GITHUB_TOKEN: "github-secret",
      GITHUB_RUN_ID: "1234",
    });
    expect(result).toMatchObject({ code: 0, stdout: "Recorded preview-pr-42 deployment 73\n", stderr: "" });
    expect(requests.map(({ url }) => url)).toEqual(["/repos/greg/clearclose/deployments", "/repos/greg/clearclose/deployments/73/statuses"]);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ ref: sha, environment: "preview-pr-42", transient_environment: true });
    expect(JSON.parse(requests[1]!.body)).toMatchObject({ state: "success", environment_url: "https://clearclose-app-pr-42.pages.dev" });
    expect(`${result.stdout}${result.stderr}`).not.toContain("github-secret");
  });

  it("marks every preview deployment inactive during teardown", async () => {
    const states: unknown[] = [];
    const base = await api((request, response) => {
      if (request.method === "GET") {
        response.statusCode = 200;
        response.end('[{"id":1},{"id":2}]');
        return;
      }
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        states.push(JSON.parse(body));
        response.statusCode = 201;
        response.end('{"id":3}');
      });
    });
    const result = await run("github-deployment.mjs", ["deactivate", "preview-pr-42"], {
      GITHUB_API_URL: base,
      GITHUB_REPOSITORY: "greg/clearclose",
      GITHUB_TOKEN: "github-secret",
    });
    expect(result).toMatchObject({ code: 0, stdout: "Deactivated 2 preview-pr-42 deployment(s)\n", stderr: "" });
    expect(states).toEqual([expect.objectContaining({ state: "inactive" }), expect.objectContaining({ state: "inactive" })]);
  });
});
