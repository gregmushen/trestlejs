import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const servers: Array<ReturnType<typeof createServer>> = [];
const temporaryDirectories: string[] = [];
const template = path.resolve("packages/create/template");

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
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
  it("runs provider preflight before Neon or staging/production database mutations", async () => {
    const preview = await readFile(path.join(template, ".github/workflows/preview.yml"), "utf8");
    const deploy = await readFile(path.join(template, ".github/workflows/deploy.yml"), "utf8");
    expect(preview.indexOf("cloudflare-preflight.mjs")).toBeGreaterThan(0);
    expect(preview.indexOf("cloudflare-preflight.mjs")).toBeLessThan(preview.indexOf("neon-preview.mjs ensure"));
    expect(preview.indexOf("neon-preflight.mjs")).toBeLessThan(preview.indexOf("neon-preview.mjs ensure"));
    expect(preview.indexOf("cloudflare-preflight.mjs")).toBeLessThan(preview.indexOf("trestle doctor --env preview"));
    expect(preview.indexOf("neon-preflight.mjs")).toBeLessThan(preview.indexOf("trestle doctor --env preview"));
    expect(preview.indexOf("steps.cloudflare_access.outcome")).toBeLessThan(preview.indexOf("trestle doctor --env preview"));
    expect(preview.indexOf("steps.neon_access.outcome")).toBeLessThan(preview.indexOf("trestle doctor --env preview"));
    expect(preview.indexOf("trestle doctor --env preview")).toBeLessThan(preview.indexOf("neon-preview.mjs ensure"));
    expect(deploy.indexOf("trestle doctor --env staging")).toBeLessThan(deploy.indexOf("Bootstrap staging runtime role"));
    expect(deploy.indexOf("trestle doctor --env production")).toBeLessThan(deploy.indexOf("Bootstrap production runtime role"));
    expect((deploy.match(/cloudflare-preflight\.mjs/gu) ?? [])).toHaveLength(2);
  });

  it("verifies Cloudflare token, Pages, and Workers account access before provider mutation", async () => {
    const requests: string[] = [];
    const base = await api((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(request.url === "/user/tokens/verify" ? '{"success":true,"result":{"status":"active"}}' : '{"success":true,"result":[]}');
    });
    const accountId = "a".repeat(32);
    const result = await run("cloudflare-preflight.mjs", [], { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: "top-secret", CLOUDFLARE_API_BASE: base });
    expect(result.code).toBe(0);
    expect(requests).toEqual(["/user/tokens/verify", `/accounts/${accountId}/pages/projects?per_page=1`, `/accounts/${accountId}/workers/scripts`]);
    expect(result.stdout).toContain("access verified");
    expect(`${result.stdout}${result.stderr}`).not.toContain("top-secret");
  });

  it("fails Cloudflare preflight on rejected credentials without revealing the token", async () => {
    const base = await api((_request, response) => { response.statusCode = 401; response.end("top-secret provider body"); });
    const result = await run("cloudflare-preflight.mjs", [], { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "top-secret", CLOUDFLARE_API_BASE: base });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("rejected the configured Cloudflare token");
    expect(`${result.stdout}${result.stderr}`).not.toContain("top-secret");
  });

  it("follows only same-origin redirects in deployed smoke checks", async () => {
    const base = await api((request, response) => {
      if (request.url === "/features") {
        response.statusCode = 308;
        response.setHeader("location", "/features/");
        response.end();
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-type", "text/html");
      response.end("<h1>Features</h1>");
    });
    const { fetchSameOrigin } = await import("../template/scripts/smoke-http.mjs") as {
      fetchSameOrigin: (url: string) => Promise<Response>;
    };
    const response = await fetchSameOrigin(`${base}/features`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Features");
  });

  it("rejects cross-origin redirects in deployed smoke checks", async () => {
    const base = await api((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", "https://attacker.example/phish");
      response.end();
    });
    const { fetchSameOrigin } = await import("../template/scripts/smoke-http.mjs") as {
      fetchSameOrigin: (url: string) => Promise<Response>;
    };
    await expect(fetchSameOrigin(`${base}/sign-in`)).rejects.toThrow("Cross-origin redirect rejected");
  });

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

  it("retries transient Pages reads", async () => {
    let attempts = 0;
    const base = await api((_request, response) => {
      attempts += 1;
      response.statusCode = attempts < 3 ? 500 : 200;
      response.end('{"success":true}');
    });
    const result = await run("cloudflare-pages.mjs", ["ensure", "clearclose-app-pr-42"], {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "top-secret",
      CLOUDFLARE_API_BASE: base,
    });
    expect(result).toMatchObject({ code: 0, stdout: "Reusing clearclose-app-pr-42\n", stderr: "" });
    expect(attempts).toBe(3);
  });

  it("reconciles an ambiguous Pages create response", async () => {
    let exists = false;
    const methods: string[] = [];
    const base = await api((request, response) => {
      methods.push(request.method ?? "");
      if (request.method === "POST") {
        exists = true;
        response.statusCode = 500;
      } else {
        response.statusCode = exists ? 200 : 404;
      }
      response.end('{"success":false}');
    });
    const result = await run("cloudflare-pages.mjs", ["ensure", "clearclose-app-pr-42"], {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "top-secret",
      CLOUDFLARE_API_BASE: base,
    });
    expect(result).toMatchObject({ code: 0, stdout: "Reusing clearclose-app-pr-42\n", stderr: "" });
    expect(methods).toEqual(["GET", "POST", "GET"]);
  });

  it("reports actionable Pages credential failures without exposing the token", async () => {
    const base = await api((_request, response) => { response.statusCode = 403; response.end('{"errors":[{"message":"denied"}]}'); });
    const result = await run("cloudflare-pages.mjs", ["ensure", "clearclose-app-pr-42"], {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "top-secret",
      CLOUDFLARE_API_BASE: base,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("non-expired token with Cloudflare Pages write permission");
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

  it("creates an isolated Neon branch and writes masked connection outputs", async () => {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const base = await api((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        requests.push({ method: request.method ?? "", url: request.url ?? "", body });
        response.setHeader("content-type", "application/json");
        if (request.method === "GET" && request.url?.includes("/branches?")) response.end('{"branches":[]}');
        else if (request.method === "POST") { response.statusCode = 201; response.end('{"branch":{"id":"br-preview-42"}}'); }
        else if (request.url?.includes("role_name=owner")) response.end('{"uri":"postgresql://owner:migration-secret@host/db"}');
        else response.end('{"uri":"postgresql://runtime:runtime-secret@host-pooler/db"}');
      });
    });
    const directory = await mkdtemp(path.join(os.tmpdir(), "trestle-neon-"));
    temporaryDirectories.push(directory);
    const output = path.join(directory, "github-output");
    const result = await run("neon-preview.mjs", ["ensure", "pr-42"], {
      NEON_API_BASE: base,
      NEON_API_KEY: "neon-secret",
      NEON_PROJECT_ID: "project-1",
      NEON_DATABASE: "app",
      NEON_MIGRATION_ROLE: "owner",
      GITHUB_OUTPUT: output,
      GITHUB_ACTIONS: "false",
    });
    expect(result).toMatchObject({ code: 0, stdout: "Ready pr-42\n", stderr: "" });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "POST", "GET"]);
    expect(JSON.parse(requests[1]!.body)).toEqual({ branch: { name: "pr-42" }, endpoints: [{ type: "read_write" }] });
    const outputs = await readFile(output, "utf8");
    expect(outputs).toContain("branch_id=br-preview-42");
    expect(outputs).toContain("migration-secret");
    expect(outputs).not.toContain("runtime-secret");
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/neon-secret|migration-secret|runtime-secret/u);
  });

  it("resolves the runtime connection only after the restricted role is configured", async () => {
    const base = await api((request, response) => { response.setHeader("content-type", "application/json"); if (request.url?.includes("/branches?")) response.end('{"branches":[{"id":"br-preview-42","name":"pr-42"}]}'); else response.end('{"uri":"postgresql://runtime:runtime-secret@host-pooler/db"}'); });
    const directory = await mkdtemp(path.join(os.tmpdir(), "trestle-neon-runtime-")); temporaryDirectories.push(directory); const output = path.join(directory, "github-output");
    const result = await run("neon-preview.mjs", ["runtime", "pr-42"], { NEON_API_BASE: base, NEON_API_KEY: "neon-secret", NEON_PROJECT_ID: "project-1", NEON_DATABASE: "app", NEON_RUNTIME_ROLE: "trestle_runtime", GITHUB_OUTPUT: output, GITHUB_ACTIONS: "false" });
    expect(result).toMatchObject({ code: 0, stdout: "Resolved runtime connection for pr-42\n", stderr: "" });
    expect(await readFile(output, "utf8")).toContain("runtime_url=postgresql://runtime:runtime-secret@host-pooler/db");
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/neon-secret|runtime-secret/u);
  });

  it("deletes an exact Neon preview branch and treats absence as idempotent", async () => {
    let present = true;
    const base = await api((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") response.end(present ? '{"branches":[{"id":"br-preview-42","name":"pr-42"}]}' : '{"branches":[]}');
      else { present = false; response.end('{"branch":{"id":"br-preview-42"}}'); }
    });
    const environment = { NEON_API_BASE: base, NEON_API_KEY: "neon-secret", NEON_PROJECT_ID: "project-1" };
    const deleted = await run("neon-preview.mjs", ["delete", "pr-42"], environment);
    expect(deleted).toMatchObject({ code: 0, stdout: "Deleted pr-42\n", stderr: "" });
    const absent = await run("neon-preview.mjs", ["delete", "pr-42"], environment);
    expect(absent).toMatchObject({ code: 0, stdout: "pr-42 already absent\n", stderr: "" });
  });
});
