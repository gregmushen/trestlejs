import { randomBytes, timingSafeEqual } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { parseSetupPlan, TRESTLEJS_VERSION, type EnvironmentName, type ProjectManifest, type SetupPlan } from "@trestlejs/core";

import { runDoctor } from "./doctor.js";
import { diffSetupPlan, applySetupPlan, formatPlanDiff } from "./plan.js";
import { credentialsPaths, initializeSecrets, readSecrets, validateSecrets, writeSecrets } from "./secrets.js";

const maxRequestBytes = 64 * 1024;

export function setupPlanFromManifest(manifest: ProjectManifest): SetupPlan {
  return parseSetupPlan(JSON.stringify({
    schemaVersion: 1,
    minimumTrestleVersion: TRESTLEJS_VERSION,
    project: manifest.project,
    apps: { site: Boolean(manifest.apps.site), app: Boolean(manifest.apps.app), worker: Boolean(manifest.apps.worker) },
    tenancy: manifest.tenancy,
    database: { engine: manifest.database.engine, provider: manifest.database.defaultProvider },
    capabilities: manifest.capabilities,
    integrations: { email: Boolean(manifest.packages.integrations), billing: Boolean(manifest.packages.billing) },
    environments: manifest.environments,
    secrets: Object.entries(manifest.secrets ?? {}).map(([name, declaration]) => ({ name, target: declaration.target, required: declaration.required })),
    resources: [],
    externalResources: [],
    destructiveOperations: [],
    verification: { commands: ["pnpm check", "pnpm exec trestle doctor"] },
  }));
}

export async function loadSetupPlan(root: string, manifest: ProjectManifest, resume = false): Promise<{ plan: SetupPlan; input: string; saved: boolean }> {
  const file = path.join(root, ".trestle", "setup.json");
  const saved = await readFile(file, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (resume && saved === undefined) throw new Error("No saved SetupPlan exists; start with trestle setup");
  if (saved !== undefined) return { plan: parseSetupPlan(saved), input: saved, saved: true };
  const plan = setupPlanFromManifest(manifest);
  return { plan, input: `${JSON.stringify(plan, null, 2)}\n`, saved: false };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function formBody(request: IncomingMessage): Promise<URLSearchParams> {
  if (!(request.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) throw new Error("Expected a form submission");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxRequestBytes) throw new Error("Form is too large");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function respond(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  response.end(body);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Trestle setup</title><style>body{font:16px/1.5 system-ui;max-width:760px;margin:3rem auto;padding:0 1rem;color:#17212b}main{display:grid;gap:1.5rem}section{border:1px solid #ccd4dc;border-radius:12px;padding:1.2rem}textarea,input{box-sizing:border-box;width:100%;padding:.65rem;font:inherit}textarea{min-height:23rem;font:13px/1.4 ui-monospace,monospace}button{padding:.65rem 1rem;margin-top:.7rem;font:inherit;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7f9;padding:1rem}small{color:#52616d}.error{color:#a00}.ok{color:#16612e}</style></head><body><main><header><h1>Trestle setup</h1><p>Local project configuration</p></header>${body}</main></body></html>`;
}

export type SetupConsole = Readonly<{ url: string; accessCode: string; closed: Promise<void>; close: () => Promise<void> }>;

export async function startSetupConsole(root: string, manifest: ProjectManifest, environment: EnvironmentName, masterKey?: string, resume = false): Promise<SetupConsole> {
  await loadSetupPlan(root, manifest, resume);
  const accessCode = randomBytes(24).toString("hex");
  const cookieValue = randomBytes(32).toString("hex");
  const csrf = randomBytes(32).toString("hex");
  let accessCodeUsed = false;
  let port = 0;
  let working = false;

  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${port}`;
    if (request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== origin)) {
      respond(response, 403, page("Forbidden", "<p>Invalid setup origin.</p>"));
      return;
    }
    const authenticated = (request.headers.cookie ?? "").split(";").some((part) => {
      const [name, value] = part.trim().split("=");
      return name === "trestle_setup" && value !== undefined && equalSecret(value, cookieValue);
    });
    const pathname = new URL(request.url ?? "/", origin).pathname;
    try {
      if (pathname === "/session" && request.method === "POST") {
        const form = await formBody(request);
        if (accessCodeUsed || !equalSecret(form.get("code") ?? "", accessCode)) {
          respond(response, 403, page("Access denied", "<p>Invalid or used access code.</p>"));
          return;
        }
        accessCodeUsed = true;
        respond(response, 303, "", { "set-cookie": `trestle_setup=${cookieValue}; HttpOnly; SameSite=Strict; Path=/`, location: "/" });
        return;
      }
      if (!authenticated) {
        respond(response, 200, page("Access", '<section><h2>One-time access code</h2><form method="post" action="/session" autocomplete="off"><label>Code<input name="code" type="password" required autocomplete="off"></label><button>Open setup</button></form></section>'));
        return;
      }
      if (request.method === "POST") {
        const form = await formBody(request);
        if (!equalSecret(form.get("csrf") ?? "", csrf)) {
          respond(response, 403, page("Forbidden", "<p>Invalid form token.</p>"));
          return;
        }
        if (working) {
          respond(response, 409, page("Busy", "<p>Another setup operation is running.</p>"));
          return;
        }
        working = true;
        try {
          if (pathname === "/plan") {
            const input = form.get("plan") ?? "";
            const plan = parseSetupPlan(input);
            await writeFile(path.join(root, ".trestle", "setup.json"), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
          } else if (pathname === "/secret") {
            const name = form.get("name") ?? "";
            const value = form.get("value") ?? "";
            if (!manifest.secrets?.[name] || !value) throw new Error("Select a declared secret and enter a value");
            const encrypted = credentialsPaths(root, environment).encrypted;
            if (!(await access(encrypted).then(() => true, () => false))) {
              if (masterKey) await writeSecrets(root, environment, {}, masterKey);
              else await initializeSecrets(root, environment);
            }
            const values = await readSecrets(root, environment, masterKey);
            const next = { ...values, [name]: value };
            const invalid = validateSecrets(next, manifest, environment).filter((problem) => problem.includes("not declared"));
            if (invalid.length) throw new Error("Credential names must be declared in the project manifest");
            await writeSecrets(root, environment, next, masterKey);
          } else if (pathname === "/apply") {
            const { plan, input, saved } = await loadSetupPlan(root, manifest, true);
            if (!saved) throw new Error("Save the SetupPlan before applying it");
            await applySetupPlan(root, manifest, plan, input);
          } else {
            respond(response, 404, page("Not found", "<p>Unknown setup action.</p>"));
            return;
          }
          respond(response, 303, "", { location: "/" });
        } finally {
          working = false;
        }
        return;
      }
      if (request.method !== "GET" || pathname !== "/") {
        respond(response, 404, page("Not found", "<p>Unknown setup page.</p>"));
        return;
      }
      const { plan, input, saved } = await loadSetupPlan(root, manifest);
      const diff = await diffSetupPlan(root, manifest, plan, input);
      const encrypted = credentialsPaths(root, environment).encrypted;
      const credentialsExist = await access(encrypted).then(() => true, () => false);
      const values = credentialsExist ? await readSecrets(root, environment, masterKey) : {};
      const secretRows = Object.entries(manifest.secrets ?? {}).map(([name, declaration]) => `<li>${escapeHtml(name)} · ${declaration.required.includes(environment) ? "required" : "optional"} · <span class="${values[name] ? "ok" : "error"}">${values[name] ? "present" : "missing"}</span></li>`).join("");
      const doctor = await runDoctor(root, manifest, environment, masterKey);
      respond(response, 200, page("Review", `<section><h2>Project and capabilities</h2><p>${escapeHtml(manifest.project.name)} · ${escapeHtml(environment)}</p><p>Capabilities: ${escapeHtml(Object.entries(plan.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "none")}</p><small>Review the JSON plan before applying changes. Existing source is preserved.</small></section><section><h2>Credentials</h2><ul>${secretRows || "<li>No declared credentials</li>"}</ul><form method="post" action="/secret" autocomplete="off"><input type="hidden" name="csrf" value="${csrf}"><label>Name<select name="name">${Object.keys(manifest.secrets ?? {}).map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}</select></label><label>Value<input type="password" name="value" required autocomplete="off"></label><button>Encrypt credential</button></form><small>Values are encrypted immediately and are never shown again here. Use trestle secrets edit to view or edit locally.</small></section><section><h2>SetupPlan ${saved ? "saved" : "draft"}</h2><form method="post" action="/plan"><input type="hidden" name="csrf" value="${csrf}"><textarea name="plan" spellcheck="false">${escapeHtml(input)}</textarea><button>Save and validate plan</button></form></section><section><h2>Proposed changes</h2><pre>${escapeHtml(formatPlanDiff(diff))}</pre><form method="post" action="/apply"><input type="hidden" name="csrf" value="${csrf}"><button ${saved ? "" : "disabled"}>Apply reviewed plan</button></form></section><section><h2>Doctor</h2><p>${doctor.summary.passed} passed · ${doctor.summary.failed} failed</p><small>Run pnpm exec trestle doctor --env ${escapeHtml(environment)} for complete evidence.</small></section>`));
    } catch (error) {
      // Credential operations cross a secret-bearing boundary. Provider, parser, or
      // encryption errors must never be reflected into the browser response.
      const message = pathname === "/secret"
        ? "Unable to save credential; check the declared name and local master key"
        : error instanceof Error ? error.message : "Setup operation failed";
      respond(response, 400, page("Setup error", `<p class="error">${escapeHtml(message)}</p><p><a href="/">Return to setup</a></p>`));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind local setup console");
  port = address.port;
  const closed = new Promise<void>((resolve) => server.once("close", resolve));
  return { url: `http://127.0.0.1:${port}/`, accessCode, closed, close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
