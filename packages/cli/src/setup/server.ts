import { spawn } from "node:child_process";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import {
  environmentNameSchema,
  loadProjectManifest,
  ManifestError,
  setupPlanSchema,
  SetupPlanError,
  TRESTLEJS_VERSION,
  type EnvironmentName,
  type ProjectManifest,
  type SetupPlan,
} from "@trestlejs/core";

import { inspectCapabilities, readEvidence, writeEvidence, type EvidenceDocument } from "../capabilities.js";
import { runDoctor } from "../doctor.js";
import { applySetupPlan, diffSetupPlan, readApplyState, versionAtLeast } from "../plan.js";
import { CliFailure } from "../runtime.js";
import { credentialsPaths, initializeSecrets, readSecrets, SecretsError, writeSecrets } from "../secrets.js";
import { connectionProviders, isConnectionProvider, providerCheckEvidence, testConnection, type ConnectionResult } from "./connections.js";
import { renderSetupPage } from "./page.js";
import { randomToken, readCookie, safeEqual, secretFingerprint, secretLikeValues } from "./security.js";

export type SetupServerOptions = {
  root: string;
  environment: EnvironmentName;
  initialPlan: SetupPlan;
  planOnly?: boolean;
  masterKey?: string | undefined;
  port?: number;
  open?: boolean;
  opener?: (url: string) => void;
  fetch?: typeof fetch;
  clock?: () => Date;
  idleTimeoutMs?: number;
};

export type SetupServer = {
  url: string;
  launchUrl: string;
  token: string;
  port: number;
  handle: (request: IncomingMessage, response: ServerResponse) => void;
  close: () => Promise<void>;
  closed: Promise<void>;
};

export const SESSION_COOKIE = "trestle_setup";
const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

export function openBrowser(url: string): void {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] as const
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] as const
      : ["xdg-open", [url]] as const;
  try {
    const child = spawn(command, [...args], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch { /* the printed URL remains available */ }
}

function securityHeaders(nonce?: string): Record<string, string> {
  const script = nonce ? `'nonce-${nonce}'` : "'none'";
  return {
    "cache-control": "no-store",
    pragma: "no-cache",
    "content-security-policy": `default-src 'none'; script-src ${script}; style-src ${script}; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { ...securityHeaders(), "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), ...headers });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "requests must use application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "request body is too large");
    chunks.push(chunk as Buffer);
  }
  const buffer = Buffer.concat(chunks);
  try {
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  } finally {
    buffer.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request", "request body must be a JSON object");
  return value as Record<string, unknown>;
}

function safeMessage(error: unknown): string {
  if (error instanceof CliFailure || error instanceof SecretsError || error instanceof ManifestError || error instanceof SetupPlanError || error instanceof HttpError) return error.message;
  return "unexpected setup console error";
}

const fileExists = (file: string) => access(file).then(() => true, () => false);

export async function createSetupServer(options: SetupServerOptions): Promise<SetupServer> {
  const { root } = options;
  const clock = options.clock ?? (() => new Date());
  const fetcher = options.fetch ?? globalThis.fetch;
  const idleTimeoutMs = options.idleTimeoutMs ?? 60 * 60 * 1000;
  const planPath = path.join(root, ".trestle", "setup.json");
  const token = randomToken();
  let tokenUsed = false;
  const sessions = new Map<string, { csrf: string }>();
  let draft: SetupPlan = structuredClone(options.initialPlan);
  let draftSaved = false;
  const secretUpdates = new Map<string, string>();
  const connections = new Map<string, ConnectionResult>();
  let port = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const masterKeyFor = (environment: EnvironmentName) => environment === options.environment ? options.masterKey : undefined;
  const manifest = () => loadProjectManifest(root);

  const environmentOf = (value: unknown, current: ProjectManifest): EnvironmentName => {
    const parsed = environmentNameSchema.safeParse(value ?? options.environment);
    if (!parsed.success || !current.environments.includes(parsed.data)) throw new HttpError(400, "invalid_environment", "environment is not declared in .trestle/project.yaml");
    return parsed.data;
  };

  async function credentials(environment: EnvironmentName): Promise<{ status: "available" | "locked" | "missing"; values?: Record<string, string>; updatedAt?: string }> {
    const paths = credentialsPaths(root, environment);
    const info = await stat(paths.encrypted).catch(() => undefined);
    if (!info) return { status: "missing", values: {} };
    try {
      return { status: "available", values: await readSecrets(root, environment, masterKeyFor(environment)), updatedAt: info.mtime.toISOString() };
    } catch {
      return { status: "locked", updatedAt: info.mtime.toISOString() };
    }
  }

  async function environmentState(current: ProjectManifest, environment: EnvironmentName) {
    const document = await credentials(environment);
    const secrets = Object.entries(current.secrets ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, declaration]) => {
      const required = declaration.required.includes(environment);
      const value = document.values?.[name];
      const updatedAt = secretUpdates.get(`${environment}:${name}`);
      return {
        name,
        target: declaration.target,
        required,
        status: document.status === "locked" ? "unknown" : value ? "set" : required ? "missing" : "optional",
        ...(value ? { fingerprint: secretFingerprint(name, value) } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      };
    });
    const report = await inspectCapabilities(root, current, environment, { secrets: document.values, evidence: await readEvidence(root, environment) });
    if (document.values) for (const name of Object.keys(document.values)) document.values[name] = "";
    return {
      environment,
      credentials: { status: document.status, ...(document.updatedAt ? { updatedAt: document.updatedAt } : {}) },
      secrets,
      capabilities: report.capabilities,
      connections: Object.fromEntries([...connections.entries()].filter(([key]) => key.startsWith(`${environment}:`)).map(([key, value]) => [key.slice(environment.length + 1), value])),
    };
  }

  async function deploymentState(current: ProjectManifest) {
    const workflows = await readdir(path.join(root, ".github", "workflows")).catch(() => [] as string[]);
    const cloudflare = Object.fromEntries(await Promise.all(Object.entries(current.apps).map(async ([name, relative]) => [name, await fileExists(path.join(root, relative, "wrangler.jsonc"))] as const)));
    return { githubWorkflows: workflows.filter((file) => /\.ya?ml$/u.test(file)).sort(), cloudflare };
  }

  async function savedPlan(): Promise<{ plan: SetupPlan; input: string } | undefined> {
    let input: string;
    try { input = await readFile(planPath, "utf8"); }
    catch { return undefined; }
    let document: unknown;
    try { document = JSON.parse(input); }
    catch { throw new HttpError(409, "invalid_saved_plan", ".trestle/setup.json is not valid JSON"); }
    const result = setupPlanSchema.safeParse(document);
    if (!result.success) throw new HttpError(409, "invalid_saved_plan", ".trestle/setup.json is invalid", { issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
    return { plan: result.data, input };
  }

  async function handleApi(request: IncomingMessage, response: ServerResponse, pathname: string, method: string): Promise<void> {
    if (method === "GET" && pathname === "/api/state") {
      const current = await manifest();
      const applyState = await readApplyState(root);
      sendJson(response, 200, {
        project: { name: current.project.name, root, trestleVersion: TRESTLEJS_VERSION },
        planOnly: Boolean(options.planOnly),
        environment: options.environment,
        environments: current.environments,
        plan: draft,
        planSaved: draftSaved,
        savedPlanExists: await fileExists(planPath),
        manifest: {
          apps: current.apps,
          packages: Object.keys(current.packages).sort(),
          capabilities: current.capabilities,
          database: current.database,
          integrations: current.integrations ?? null,
          access: current.access ?? null,
          commercial: current.commercial ?? null,
          artifacts: current.artifacts ?? null,
        },
        environmentStates: await Promise.all(current.environments.map((environment) => environmentState(current, environment))),
        deployment: await deploymentState(current),
        lastApply: applyState ? { planHash: applyState.planHash, updatedAt: applyState.updatedAt } : null,
      });
      return;
    }

    if (method === "PUT" && pathname === "/api/plan") {
      const current = await manifest();
      const body = await readJson(request);
      const leaks = secretLikeValues(body, new Set(Object.keys(current.secrets ?? {})));
      if (leaks.length) throw new HttpError(400, "secret_value_rejected", "SetupPlans must not contain secret values", { issues: leaks.map((message) => ({ path: message.split(":")[0], message })) });
      const result = setupPlanSchema.safeParse(body);
      if (!result.success) throw new HttpError(400, "invalid_plan", "SetupPlan is invalid", { issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
      if (!versionAtLeast(TRESTLEJS_VERSION, result.data.minimumTrestleVersion)) throw new HttpError(400, "invalid_plan", `SetupPlan requires TrestleJS ${result.data.minimumTrestleVersion} or newer`, { issues: [{ path: "minimumTrestleVersion", message: `installed ${TRESTLEJS_VERSION}` }] });
      const input = `${JSON.stringify(result.data, null, 2)}\n`;
      await writeFile(planPath, input, "utf8");
      draft = result.data;
      draftSaved = true;
      const diff = await diffSetupPlan(root, current, result.data, input);
      sendJson(response, 200, { saved: true, path: ".trestle/setup.json", planHash: diff.planHash });
      return;
    }

    if (method === "GET" && pathname === "/api/diff") {
      const saved = await savedPlan();
      if (!saved) throw new HttpError(404, "no_plan", "save the SetupPlan before reviewing its diff");
      sendJson(response, 200, await diffSetupPlan(root, await manifest(), saved.plan, saved.input));
      return;
    }

    if (method === "POST" && pathname === "/api/secrets") {
      if (options.planOnly) throw new HttpError(403, "plan_only", "credential changes are disabled in --plan-only mode");
      const current = await manifest();
      const body = record(await readJson(request));
      try {
        const environment = environmentOf(body.environment, current);
        const name = body.name;
        if (typeof name !== "string" || !current.secrets?.[name]) throw new HttpError(400, "undeclared_secret", "secret name is not declared in .trestle/project.yaml");
        if (typeof body.value !== "string" || body.value.length === 0 || body.value.length > 16_384) throw new HttpError(400, "invalid_secret", "secret value must be a non-empty string of at most 16384 characters");
        const paths = credentialsPaths(root, environment);
        let values: Record<string, string>;
        if (await fileExists(paths.encrypted)) {
          try { values = await readSecrets(root, environment, masterKeyFor(environment)); }
          catch { throw new HttpError(409, "credentials_locked", `the ${environment} master key is unavailable; set TRESTLE_MASTER_KEY or restore ${path.relative(root, paths.key)}`); }
        } else {
          if (!masterKeyFor(environment) && !(await fileExists(paths.key))) await initializeSecrets(root, environment);
          values = {};
        }
        values[name] = body.value;
        const fingerprint = secretFingerprint(name, body.value);
        await writeSecrets(root, environment, values, masterKeyFor(environment));
        for (const key of Object.keys(values)) values[key] = "";
        const updatedAt = clock().toISOString();
        secretUpdates.set(`${environment}:${name}`, updatedAt);
        sendJson(response, 200, { name, environment, status: "set", fingerprint, updatedAt });
      } finally {
        body.value = undefined;
      }
      return;
    }

    if (method === "POST" && pathname === "/api/connections/test") {
      const current = await manifest();
      const body = record(await readJson(request));
      const environment = environmentOf(body.environment, current);
      if (!isConnectionProvider(body.provider)) throw new HttpError(400, "invalid_provider", `provider must be one of ${Object.keys(connectionProviders).join(", ")}`);
      const document = await credentials(environment);
      const result = await testConnection(body.provider, document.values, fetcher, clock);
      if (document.values) for (const key of Object.keys(document.values)) document.values[key] = "";
      connections.set(`${environment}:${body.provider}`, result);
      sendJson(response, 200, result);
      return;
    }

    if (method === "POST" && pathname === "/api/apply") {
      if (options.planOnly) throw new HttpError(403, "plan_only", "apply is disabled in --plan-only mode");
      const current = await manifest();
      const body = record(await readJson(request));
      const environment = environmentOf(body.environment, current);
      if (body.approved !== true) throw new HttpError(400, "approval_required", "apply requires explicit approval of the reviewed diff");
      const saved = await savedPlan();
      if (!saved) throw new HttpError(404, "no_plan", "save the SetupPlan before applying it");
      if (!versionAtLeast(TRESTLEJS_VERSION, saved.plan.minimumTrestleVersion)) throw new HttpError(409, "unsupported_plan", `SetupPlan requires TrestleJS ${saved.plan.minimumTrestleVersion} or newer`);
      const diff = await diffSetupPlan(root, current, saved.plan, saved.input);
      if (typeof body.planHash !== "string" || !safeEqual(body.planHash, diff.planHash)) throw new HttpError(409, "stale_plan", "the approved diff no longer matches the saved SetupPlan; review the diff again");
      let operations;
      try {
        operations = (await applySetupPlan(root, current, saved.plan, saved.input)).operations;
      } catch (error) {
        if (error instanceof CliFailure) throw new HttpError(409, "apply_blocked", error.message, { operations: (await readApplyState(root))?.operations ?? [] });
        throw error;
      }
      const updated = await manifest();
      const doctor = await runDoctor(root, updated, environment, masterKeyFor(environment));
      const document = await credentials(environment);
      const previous = await readEvidence(root, environment);
      const report = await inspectCapabilities(root, updated, environment, { secrets: document.values, evidence: previous });
      const checkedAt = clock().toISOString();
      const passed = doctor.summary.failed === 0;
      const evidence: EvidenceDocument = {
        schemaVersion: 1,
        environment,
        recordedAt: checkedAt,
        doctor: { ...doctor.summary },
        capabilities: Object.fromEntries(report.capabilities.filter((capability) => capability.healthy && capability.state !== "disabled").map((capability) => {
          const deployed = environment !== "local" && Boolean(previous?.capabilities[capability.id]?.deployed);
          return [capability.id, { ...(deployed ? { deployed } : {}), verified: passed && (environment === "local" || deployed), checkedAt }];
        })),
        // Connection checks run in this session become non-secret evidence; earlier results are kept.
        ...providerCheckEvidence(previous, environment, connections),
        ...(previous?.scimTransactions ? { scimTransactions: previous.scimTransactions } : {}),
      };
      const final = await inspectCapabilities(root, updated, environment, { secrets: document.values, evidence });
      if (document.values) for (const key of Object.keys(document.values)) document.values[key] = "";
      await writeEvidence(root, evidence);
      sendJson(response, 200, {
        planHash: diff.planHash,
        operations,
        doctor: {
          summary: doctor.summary,
          checks: doctor.checks.map((check) => ({ id: check.id, group: check.group, status: check.status, message: check.message, ...(check.remediation ? { remediation: check.remediation } : {}) })),
        },
        capabilities: final.capabilities,
        evidence: path.join(".trestle", "evidence", `${environment}.json`),
      });
      return;
    }

    if (method === "POST" && pathname === "/api/close") {
      sendJson(response, 200, { closed: true });
      setImmediate(() => { void close(); });
      return;
    }

    throw new HttpError(404, "not_found", "not found");
  }

  function scheduleIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { void close(); }, idleTimeoutMs);
    idleTimer.unref();
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const host = request.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, "forbidden_host", "requests must target the loopback setup address");
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, "forbidden_origin", "cross-origin requests are not allowed");
    if (request.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "forbidden_origin", "cross-site requests are not allowed");
    const url = new URL(request.url ?? "/", `http://${host}`);

    if (method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
      if (tokenUsed || !safeEqual(url.searchParams.get("token") ?? "", token)) throw new HttpError(403, "invalid_token", "this setup link is invalid or has already been used; restart trestle setup");
      tokenUsed = true;
      scheduleIdle();
      const sessionId = randomToken();
      sessions.set(sessionId, { csrf: randomToken() });
      response.writeHead(303, { ...securityHeaders(), location: "/", "set-cookie": `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/` });
      response.end();
      return;
    }

    const cookie = readCookie(request.headers.cookie, SESSION_COOKIE);
    let session: { csrf: string } | undefined;
    for (const [id, value] of sessions) if (safeEqual(cookie, id)) session = value;
    if (!session) throw new HttpError(401, "unauthorized", "setup session required; open the link printed by trestle setup");
    scheduleIdle();

    if (method !== "GET" && method !== "HEAD") {
      const csrf = request.headers["x-trestle-csrf"];
      if (typeof csrf !== "string" || !safeEqual(csrf, session.csrf)) throw new HttpError(403, "csrf", "missing or invalid CSRF token");
    }

    if (method === "GET" && url.pathname === "/") {
      const nonce = randomToken(16);
      const html = renderSetupPage({ nonce, csrf: session.csrf });
      response.writeHead(200, { ...securityHeaders(nonce), "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
      response.end(html);
      return;
    }
    if (url.pathname.startsWith("/api/")) return handleApi(request, response, url.pathname, method);
    throw new HttpError(404, "not_found", "not found");
  }

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof HttpError ? error.status : error instanceof ManifestError ? 409 : 500;
      const code = error instanceof HttpError ? error.code : "internal_error";
      sendJson(response, status, { error: code, message: safeMessage(error), ...(error instanceof HttpError ? error.details : {}) });
    });
  };

  const server = createServer(handle);
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  port = (server.address() as AddressInfo).port;

  function close(): Promise<void> {
    closing ??= new Promise<void>((resolve) => {
      if (idleTimer) clearTimeout(idleTimer);
      sessions.clear();
      secretUpdates.clear();
      connections.clear();
      tokenUsed = true;
      server.close(() => { resolveClosed(); resolve(); });
      server.closeAllConnections();
    });
    return closing;
  }

  scheduleIdle();
  const url = `http://127.0.0.1:${port}`;
  const launchUrl = `${url}/?token=${token}`;
  if (options.open) (options.opener ?? openBrowser)(launchUrl);
  return { url, launchUrl, token, port, handle, close, closed };
}
