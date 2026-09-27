import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseDocument } from "yaml";

import { parseProjectManifest } from "./manifest.js";

/**
 * The connection backend's secrets. NANGO_SECRET_KEY is required in deployed
 * environments (one distinct key per environment). NANGO_WEBHOOK_SECRET is
 * Nango's webhook signing key, separate from the secret key; without it the
 * Worker refuses connection callbacks, so it is declared but not required.
 */
export const nangoSecrets = {
  NANGO_SECRET_KEY: { target: "worker", required: ["staging", "production"] },
  NANGO_WEBHOOK_SECRET: { target: "worker", required: [] },
} as const;

/** Deployed environments use the selected backend; local development uses the deterministic local backend. */
function withConnectionBackend(source: string, backend: string, host: string | undefined): string {
  const pattern = /("vars"\s*:\s*\{)([^{}]*)(\})/gu;
  return source.replace(pattern, (_match, open: string, body: string, close: string) => {
    const local = /"APP_ENV"\s*:\s*"local"/u.test(body);
    const selected = local ? "local" : backend;
    let updated = body.replace(/\s*,?\s*"TRESTLE_CONNECTION_BACKEND"\s*:\s*"[^"]*"/gu, "").replace(/\s*,?\s*"NANGO_HOST"\s*:\s*"[^"]*"/gu, "");
    const additions = [`"TRESTLE_CONNECTION_BACKEND": ${JSON.stringify(selected)}`, ...(!local && host ? [`"NANGO_HOST": ${JSON.stringify(host)}`] : [])].join(", ");
    updated = updated.trim() ? `${updated.replace(/\s+$/u, "")}, ${additions} ` : ` ${additions} `;
    return `${open}${updated}${close}`;
  });
}

/**
 * Selects the tenant connection backend: writes the `integrations:` block to
 * .trestle/project.yaml, declares the backend's secret names, and sets
 * TRESTLE_CONNECTION_BACKEND in the Worker configuration. Returns the files
 * it changed. Secret values are never written here; set them with
 * `trestle secrets set`.
 */
export async function enableConnectionBackend(root: string, backend: "nango", options: Readonly<{ host?: string }> = {}): Promise<readonly string[]> {
  const manifestPath = path.join(root, ".trestle", "project.yaml");
  const source = await readFile(manifestPath, "utf8");
  const current = parseProjectManifest(source);
  const document = parseDocument(source);
  const changed: string[] = [];
  const desired = { backend, ...(options.host ? { host: options.host } : {}) };
  if (JSON.stringify(current.integrations ?? {}) !== JSON.stringify(desired)) document.set("integrations", desired);
  for (const [name, declaration] of Object.entries(nangoSecrets)) {
    if (!current.secrets?.[name]) document.setIn(["secrets", name], { target: declaration.target, required: [...declaration.required] });
    else if (name === "NANGO_SECRET_KEY") {
      const required = new Set([...current.secrets[name]!.required, ...declaration.required]);
      if (required.size !== current.secrets[name]!.required.length) document.setIn(["secrets", name, "required"], [...required]);
    }
  }
  const updated = document.toString();
  if (updated !== source) {
    if (parseProjectManifest(updated).integrations?.backend !== backend) throw new Error(`Unable to select ${backend} in the project manifest`);
    await writeFile(manifestPath, updated, "utf8");
    changed.push(".trestle/project.yaml");
  }
  const worker = current.apps.worker;
  if (worker) {
    const configPath = path.join(root, worker, "wrangler.jsonc");
    const config = await readFile(configPath, "utf8").catch(() => undefined);
    if (config !== undefined) {
      const rendered = withConnectionBackend(config, backend, options.host);
      if (rendered !== config) {
        await writeFile(configPath, rendered, "utf8");
        changed.push(path.join(worker, "wrangler.jsonc"));
      }
    }
  }
  return changed;
}
