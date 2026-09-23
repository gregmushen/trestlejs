import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseProjectManifest } from "@trestlejs/core";
import { afterEach, describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";
import { planFromManifest } from "../src/plan.js";
import { initializeSecrets, readSecrets, writeSecrets } from "../src/secrets.js";
import { createSetupServer, type SetupServer, type SetupServerOptions } from "../src/setup/index.js";

const SENTINEL = "zz-plaintext-sentinel-7Hq9vK2mX4";
const directories: string[] = [];
const servers: SetupServer[] = [];
const responses: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  responses.length = 0;
});

const manifestText = `schemaVersion: 1
project:
  name: fixture
apps:
  app: apps/app
  worker: apps/worker
packages:
  integrations: packages/integrations
tenancy:
  model: organization
  enforcement: postgres-rls
database:
  engine: postgresql
  defaultProvider: neon
capabilities:
  r2: false
  queues: false
  workflows: false
  durableObjects: false
  admin: false
integrations:
  email: local
  payments: disabled
environments: [local, staging, production]
secrets:
  RESEND_API_KEY:
    target: worker
    required: [staging, production]
  NEON_API_KEY:
    target: ci
    required: [staging]
`;

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-setup-"));
  directories.push(root);
  await mkdir(path.join(root, ".trestle"), { recursive: true });
  await mkdir(path.join(root, ".agents", "skills", "trestle-setup"), { recursive: true });
  await writeFile(path.join(root, ".agents", "skills", "trestle-setup", "SKILL.md"), "fixture\n");
  await writeFile(path.join(root, ".trestle", "project.yaml"), manifestText);
  for (const directory of ["apps/app", "apps/worker", "packages/integrations"]) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, "packages/integrations/package.json"), "{}\n");
  return root;
}

async function start(root: string, options: Partial<SetupServerOptions> = {}): Promise<SetupServer> {
  const server = await createSetupServer({ root, environment: "local", initialPlan: planFromManifest(parseProjectManifest(manifestText)), ...options });
  servers.push(server);
  return server;
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any };

function call(server: { port: number }, method: string, pathname: string, options: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  const payload = options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: server.port,
      method,
      path: pathname,
      headers: { host: `127.0.0.1:${server.port}`, ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }), ...options.headers },
    }, (incoming) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => { body += chunk; });
      incoming.on("end", () => {
        responses.push(body, JSON.stringify(incoming.headers));
        resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body, json: () => JSON.parse(body) });
      });
    });
    outgoing.on("error", reject);
    if (payload !== undefined) outgoing.write(payload);
    outgoing.end();
  });
}

async function session(server: SetupServer): Promise<{ cookie: string; csrf: string; api: (method: string, pathname: string, body?: unknown) => Promise<Reply> }> {
  const exchange = await call(server, "GET", `/?token=${server.token}`);
  expect(exchange.status).toBe(303);
  expect(exchange.headers.location).toBe("/");
  const setCookie = String(exchange.headers["set-cookie"]);
  expect(setCookie).toMatch(/^trestle_setup=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/$/u);
  const cookie = setCookie.split(";")[0]!;
  const page = await call(server, "GET", "/", { headers: { cookie } });
  const csrf = /name="trestle-csrf" content="([^"]+)"/u.exec(page.body)![1]!;
  return { cookie, csrf, api: (method, pathname, body) => call(server, method, pathname, { headers: { cookie, "x-trestle-csrf": csrf }, body }) };
}

async function everyFile(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? everyFile(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
}

async function expectNoPlaintext(root: string): Promise<void> {
  for (const file of await everyFile(root)) expect(await readFile(file, "utf8"), file).not.toContain(SENTINEL);
  for (const body of responses) expect(body).not.toContain(SENTINEL);
}

describe("trestle setup console", () => {
  it("binds to loopback, exchanges a one-time token for a session cookie, and serves a hardened page", async () => {
    const root = await project();
    const opened: string[] = [];
    const server = await start(root, { open: true, opener: (url) => opened.push(url) });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(server.port).toBeGreaterThan(0);
    expect(opened).toEqual([`${server.url}/?token=${server.token}`]);
    expect(Buffer.from(server.token, "base64url")).toHaveLength(32);

    expect((await call(server, "GET", "/")).status).toBe(401);
    expect((await call(server, "GET", "/api/state")).status).toBe(401);
    expect((await call(server, "GET", "/?token=wrong")).status).toBe(403);
    const { cookie, csrf } = await session(server);
    expect((await call(server, "GET", `/?token=${server.token}`)).status).toBe(403);

    const page = await call(server, "GET", "/", { headers: { cookie } });
    expect(page.status).toBe(200);
    const nonce = /<script nonce="([^"]+)"/u.exec(page.body)![1];
    expect(page.headers["content-security-policy"]).toContain(`script-src 'nonce-${nonce}'`);
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.body).toContain(csrf);
    expect(page.body).not.toContain(server.token);
    for (const title of ["Identity &amp; environments", "Surfaces", "Email", "Payments", "Plans &amp; entitlements", "Database", "Async processing", "Artifacts", "Access control", "Deployment environments", "Review &amp; apply"].map((value) => value.replace(/&amp;/gu, "&"))) expect(page.body).toContain(title);

    expect((await call(server, "GET", "/", { headers: { cookie: "trestle_setup=forged" } })).status).toBe(401);
  });

  it("rejects DNS-rebinding hosts, foreign origins, and missing or wrong CSRF tokens", async () => {
    const root = await project();
    const server = await start(root);
    const { cookie, csrf } = await session(server);
    expect((await call(server, "GET", "/api/state", { headers: { cookie, host: `evil.example:${server.port}` } })).status).toBe(403);
    expect((await call(server, "GET", "/api/state", { headers: { cookie, host: "127.0.0.1:1" } })).status).toBe(403);
    expect((await call(server, "GET", "/api/state", { headers: { cookie, host: `localhost:${server.port}` } })).status).toBe(200);
    expect((await call(server, "GET", "/api/state", { headers: { cookie, origin: "http://evil.example" } })).status).toBe(403);
    expect((await call(server, "GET", `/?token=${server.token}`, { headers: { host: `evil.example:${server.port}` } })).status).toBe(403);

    const plan = planFromManifest(parseProjectManifest(manifestText));
    expect((await call(server, "PUT", "/api/plan", { headers: { cookie }, body: plan })).status).toBe(403);
    expect((await call(server, "PUT", "/api/plan", { headers: { cookie, "x-trestle-csrf": `${csrf}x` }, body: plan })).status).toBe(403);
    expect((await call(server, "POST", "/api/close", { headers: { cookie, origin: `http://127.0.0.1:${server.port}` }, body: {} })).status).toBe(403);
    expect((await call(server, "PUT", "/api/plan", { headers: { cookie, "x-trestle-csrf": csrf }, body: plan })).status).toBe(200);
  });

  it("encrypts submitted credentials immediately and never returns or persists plaintext", async () => {
    const root = await project();
    await initializeSecrets(root, "local");
    const server = await start(root);
    const { api } = await session(server);

    const stored = await api("POST", "/api/secrets", { environment: "staging", name: "RESEND_API_KEY", value: SENTINEL });
    expect(stored.status).toBe(200);
    expect(stored.json()).toEqual({ name: "RESEND_API_KEY", environment: "staging", status: "set", fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/u), updatedAt: expect.any(String) });
    expect((await readSecrets(root, "staging")).RESEND_API_KEY).toBe(SENTINEL);

    const undeclared = await api("POST", "/api/secrets", { environment: "staging", name: "UNDECLARED_KEY", value: SENTINEL });
    expect(undeclared.status).toBe(400);
    expect(undeclared.json().error).toBe("undeclared_secret");
    expect((await api("POST", "/api/secrets", { environment: "preview", name: "RESEND_API_KEY", value: "x" })).status).toBe(400);
    expect((await readSecrets(root, "staging")).UNDECLARED_KEY).toBeUndefined();

    const state = (await api("GET", "/api/state")).json();
    const staging = state.environmentStates.find((item: { environment: string }) => item.environment === "staging");
    expect(staging.secrets.find((secret: { name: string }) => secret.name === "RESEND_API_KEY")).toMatchObject({ status: "set", fingerprint: stored.json().fingerprint });
    expect(staging.secrets.find((secret: { name: string }) => secret.name === "NEON_API_KEY")).toMatchObject({ status: "missing" });

    const leaked = await api("PUT", "/api/plan", { ...planFromManifest(parseProjectManifest(manifestText)), verification: { commands: ["curl -H 'Authorization: sk_live_abcdefghijklmnop'"] } });
    expect(leaked.status).toBe(400);
    const smuggled = await api("PUT", "/api/plan", { ...planFromManifest(parseProjectManifest(manifestText)), project: { name: "fixture", apiKey: SENTINEL } });
    expect(smuggled.status).toBe(400);
    expect(smuggled.json().error).toBe("secret_value_rejected");

    await api("PUT", "/api/plan", planFromManifest(parseProjectManifest(manifestText)));
    const diff = (await api("GET", "/api/diff")).json();
    const applied = await api("POST", "/api/apply", { planHash: diff.planHash, approved: true, environment: "staging" });
    expect(applied.status).toBe(200);
    expect(await readFile(path.join(root, ".trestle", "evidence", "staging.json"), "utf8")).toContain('"environment": "staging"');
    await expectNoPlaintext(root);
  });

  it("reports SetupPlan validation issues and saves valid plans", async () => {
    const root = await project();
    const server = await start(root);
    const { api } = await session(server);
    const plan = planFromManifest(parseProjectManifest(manifestText));
    const invalid = await api("PUT", "/api/plan", { ...plan, access: { customRoles: false, serviceAccounts: false, apiKeys: true } });
    expect(invalid.status).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "invalid_plan", issues: [{ path: "access.apiKeys", message: "API keys require service accounts" }] });
    expect((await api("PUT", "/api/plan", "{not json")).status).toBe(400);
    expect((await api("GET", "/api/diff")).status).toBe(404);
    const saved = await api("PUT", "/api/plan", plan);
    expect(saved.json()).toMatchObject({ saved: true, path: ".trestle/setup.json", planHash: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(JSON.parse(await readFile(path.join(root, ".trestle", "setup.json"), "utf8"))).toEqual(plan);
    expect((await api("GET", "/api/state")).json()).toMatchObject({ planSaved: true, savedPlanExists: true });
  });

  it("requires explicit approval of the current plan hash before applying and records evidence", async () => {
    const root = await project();
    const server = await start(root, { clock: () => new Date("2026-09-22T12:00:00.000Z") });
    const { api } = await session(server);
    const plan = { ...planFromManifest(parseProjectManifest(manifestText)), providers: { email: "local" as const, payments: "local" as const } };
    expect((await api("POST", "/api/apply", { planHash: "0".repeat(64), approved: true })).status).toBe(404);
    await api("PUT", "/api/plan", plan);
    const diff = (await api("GET", "/api/diff")).json();
    expect(diff.items).toContainEqual(expect.objectContaining({ id: "providers", classification: "update" }));
    expect((await api("POST", "/api/apply", { planHash: diff.planHash })).status).toBe(400);
    expect((await api("POST", "/api/apply", { planHash: diff.planHash, approved: "yes" })).status).toBe(400);
    const stale = await api("POST", "/api/apply", { planHash: "0".repeat(64), approved: true });
    expect(stale.status).toBe(409);
    expect(stale.json().error).toBe("stale_plan");
    const applied = await api("POST", "/api/apply", { planHash: diff.planHash, approved: true });
    expect(applied.status).toBe(200);
    const result = applied.json();
    expect(result.operations).toContainEqual(expect.objectContaining({ id: "providers", status: "completed" }));
    expect(result.doctor.summary).toEqual(expect.objectContaining({ failed: expect.any(Number) }));
    expect(parseProjectManifest(await readFile(path.join(root, ".trestle", "project.yaml"), "utf8")).integrations).toEqual({ email: "local", payments: "local" });
    const evidence = JSON.parse(await readFile(path.join(root, ".trestle", "evidence", "local.json"), "utf8"));
    expect(evidence).toMatchObject({ schemaVersion: 1, environment: "local", recordedAt: "2026-09-22T12:00:00.000Z" });
    expect(Object.keys(evidence.capabilities)).toContain("email");
    const blocked = await api("PUT", "/api/plan", { ...plan, apps: { ...plan.apps, site: true } });
    expect(blocked.status).toBe(200);
    const blockedDiff = (await api("GET", "/api/diff")).json();
    const refused = await api("POST", "/api/apply", { planHash: blockedDiff.planHash, approved: true });
    expect(refused.status).toBe(409);
    expect(refused.json()).toMatchObject({ error: "apply_blocked", operations: [expect.objectContaining({ id: "apps.site", status: "blocked" })] });
  });

  it("disables credential changes and apply in plan-only mode", async () => {
    const root = await project();
    const server = await start(root, { planOnly: true });
    const { api } = await session(server);
    await api("PUT", "/api/plan", planFromManifest(parseProjectManifest(manifestText)));
    const diff = (await api("GET", "/api/diff")).json();
    const apply = await api("POST", "/api/apply", { planHash: diff.planHash, approved: true });
    expect(apply.status).toBe(403);
    expect(apply.json().error).toBe("plan_only");
    expect((await api("POST", "/api/secrets", { environment: "local", name: "RESEND_API_KEY", value: SENTINEL })).status).toBe(403);
    expect((await api("GET", "/api/state")).json().planOnly).toBe(true);
    await expectNoPlaintext(root);
  });

  it("tests provider connections server-side and returns only sanitized status", async () => {
    const root = await project();
    await initializeSecrets(root, "staging");
    await writeSecrets(root, "staging", { RESEND_API_KEY: SENTINEL });
    const calls: Array<{ url: string; authorization: string | null }> = [];
    let reply: () => Response = () => new Response(`{"data":[{"name":"leaky.example"}],"echo":"${SENTINEL}"}`, { status: 200 });
    const server = await start(root, {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
        return reply();
      }) as typeof fetch,
    });
    const { api } = await session(server);
    const reachable = await api("POST", "/api/connections/test", { environment: "staging", provider: "resend" });
    expect(reachable.json()).toEqual({ provider: "resend", ok: true, status: "reachable", checkedAt: expect.any(String) });
    expect(reachable.body).not.toContain("leaky.example");
    expect(calls).toEqual([{ url: "https://api.resend.com/domains", authorization: `Bearer ${SENTINEL}` }]);

    reply = () => new Response("invalid key leaky.example", { status: 401 });
    expect((await api("POST", "/api/connections/test", { environment: "staging", provider: "resend" })).json()).toMatchObject({ ok: false, status: "unauthorized" });
    reply = () => { throw new Error(`network failure ${SENTINEL}`); };
    expect((await api("POST", "/api/connections/test", { environment: "staging", provider: "resend" })).json()).toMatchObject({ ok: false, status: "unreachable" });
    expect((await api("POST", "/api/connections/test", { environment: "staging", provider: "neon" })).json()).toMatchObject({ ok: false, status: "not_configured" });
    expect((await api("POST", "/api/connections/test", { environment: "staging", provider: "smtp" })).status).toBe(400);
    expect(calls).toHaveLength(3);
    const state = (await api("GET", "/api/state")).json();
    expect(state.environmentStates.find((item: { environment: string }) => item.environment === "staging").connections.resend.status).toBe("unreachable");
    for (const body of responses) expect(body).not.toContain("leaky.example");
    await expectNoPlaintext(root);
  });

  it("destroys the session and stops on close or idle timeout", async () => {
    const root = await project();
    const server = await start(root);
    const { api } = await session(server);
    expect((await api("POST", "/api/close", {})).json()).toEqual({ closed: true });
    await server.closed;
    await expect(call(server, "GET", "/api/state")).rejects.toThrow();

    const idle = await start(root, { idleTimeoutMs: 20 });
    await idle.closed;
    await expect(call(idle, "GET", "/")).rejects.toThrow();
  });
});

describe("trestle setup command", () => {
  function capture(root: string) {
    const output = { stdout: "", stderr: "" };
    return { output, runtime: { cwd: () => root, stdout: (text: string) => { output.stdout += text; }, stderr: (text: string) => { output.stderr += text; }, environment: () => undefined } };
  }

  it("requires a saved plan for --resume", async () => {
    const root = await project();
    const { output, runtime } = capture(root);
    expect(await executeCli(["setup", "--resume", "--no-open"], runtime)).toBe(1);
    expect(output.stderr).toContain("setup.json");
  });

  it("serves a plan-only console from the pinned CLI and exits when the session closes", async () => {
    const root = await project();
    await writeFile(path.join(root, ".trestle", "setup.json"), `${JSON.stringify(planFromManifest(parseProjectManifest(manifestText)), null, 2)}\n`);
    const { output, runtime } = capture(root);
    const running = executeCli(["setup", "--no-open", "--plan-only", "--resume", "--env", "staging"], runtime);
    let match: RegExpExecArray | null = null;
    for (let attempt = 0; attempt < 200 && !match; attempt += 1) {
      match = /Trestle setup: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/u.exec(output.stdout);
      if (!match) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(match).not.toBeNull();
    const server = { port: Number(match![1]), token: match![2]! } as SetupServer;
    const { api } = await session(server);
    const state = (await api("GET", "/api/state")).json();
    expect(state).toMatchObject({ planOnly: true, environment: "staging", savedPlanExists: true });
    const diff = (await api("GET", "/api/diff")).json();
    expect((await api("POST", "/api/apply", { planHash: diff.planHash, approved: true })).status).toBe(403);
    await api("POST", "/api/close", {});
    expect(await running).toBe(0);
    expect(output.stdout).toContain("Plan-only mode");
    expect(output.stdout).toContain("Setup session closed.");
  });

  it("rejects an undeclared credential environment", async () => {
    const root = await project();
    const { output, runtime } = capture(root);
    expect(await executeCli(["setup", "--no-open", "--env", "preview"], runtime)).toBe(1);
    expect(output.stderr).toContain("preview is not declared");
  });
});
