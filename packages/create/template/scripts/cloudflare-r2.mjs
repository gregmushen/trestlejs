import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { artifactBucketName, r2Enabled } from "./queue-config.mjs";

const apiBase = (process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4").replace(/\/$/u, "");

export function r2Client({ accountId, token, fetcher = fetch }) {
  if (!/^[a-f0-9]{32}$/u.test(accountId)) throw new Error("valid Cloudflare account ID is required");
  if (!token) throw new Error("Cloudflare API token is required");
  const endpoint = `${apiBase}/accounts/${accountId}/r2/buckets`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  async function request(url, options = {}, allowMissing = false) {
    const response = await fetcher(url, { ...options, headers });
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) throw new Error(`Cloudflare R2 request failed with HTTP ${response.status}`);
    if (response.status === 204) return { success: true };
    const body = await response.json();
    if (body.success !== true) throw new Error("Cloudflare R2 API rejected the request");
    return body;
  }
  async function get(name) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u.test(name)) throw new Error("invalid R2 bucket name");
    return await request(`${endpoint}/${name}`, {}, true);
  }
  async function ensure(name) {
    if (await get(name)) return { name, state: "existing" };
    try {
      await request(endpoint, { method: "POST", body: JSON.stringify({ name }) });
      return { name, state: "created" };
    } catch (error) {
      if (await get(name)) return { name, state: "existing" };
      throw error;
    }
  }
  async function verify(name) {
    const bucket = await get(name);
    if (!bucket || !bucket.result || typeof bucket.result !== "object"
      || (bucket.result.name && bucket.result.name !== name)) {
      throw new Error(`Cloudflare R2 bucket ${name} is missing or has an invalid identity`);
    }
    return { name, state: "present" };
  }
  async function remove(name) {
    if (!await get(name)) return { name, state: "absent" };
    // R2 rejects nonempty bucket deletion. Never purge application artifacts here.
    await request(`${endpoint}/${name}`, { method: "DELETE" });
    return { name, state: "deleted" };
  }
  return { ensure, verify, remove };
}

async function main() {
  const [operation, workerName] = process.argv.slice(2);
  if (!workerName || !["ensure", "verify", "delete-preview"].includes(operation ?? "")) throw new Error("expected ensure, verify, or delete-preview <worker-name>");
  if (operation === "delete-preview" && !/-worker-pr-[1-9][0-9]*$/u.test(workerName)) throw new Error("only isolated preview R2 buckets may be deleted");
  if (!r2Enabled(await readFile(new URL("../.trestle/project.yaml", import.meta.url), "utf8"))) {
    process.stdout.write("Cloudflare R2 disabled; no resources changed\n");
    return;
  }
  const name = artifactBucketName(workerName);
  const client = r2Client({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", token: process.env.CLOUDFLARE_API_TOKEN ?? "" });
  const result = operation === "ensure" ? await client.ensure(name) : operation === "verify" ? await client.verify(name) : await client.remove(name);
  process.stdout.write(`${result.state}: ${result.name}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
