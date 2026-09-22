import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

import { queueNames, queuesEnabled } from "./queue-config.mjs";

const apiBase = (process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4").replace(/\/$/u, "");

export function queueClient({ accountId, token, fetcher = fetch }) {
  if (!/^[a-f0-9]{32}$/u.test(accountId)) throw new Error("valid Cloudflare account ID is required");
  if (!token) throw new Error("Cloudflare API token is required");
  const endpoint = `${apiBase}/accounts/${accountId}/queues`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  async function request(url, options = {}) {
    const response = await fetcher(url, { ...options, headers });
    if (!response.ok) throw new Error(`Cloudflare Queue request failed with HTTP ${response.status}`);
    if (response.status === 204) return { success: true };
    const body = await response.json();
    if (body.success !== true) throw new Error("Cloudflare Queue API rejected the request");
    return body;
  }
  async function list() {
    const result = [];
    for (let page = 1; ; page += 1) {
      const body = await request(`${endpoint}?page=${page}&per_page=100`);
      if (!Array.isArray(body.result)) throw new Error("Cloudflare Queue list returned an invalid result");
      result.push(...body.result);
      if (page >= (body.result_info?.total_pages ?? 1)) return result;
    }
  }
  async function ensure(name) {
    const existing = (await list()).find((queue) => queue.queue_name === name);
    if (existing) return { name, state: "existing" };
    try {
      await request(endpoint, { method: "POST", body: JSON.stringify({ queue_name: name }) });
      return { name, state: "created" };
    } catch (error) {
      if ((await list()).some((queue) => queue.queue_name === name)) return { name, state: "existing" };
      throw error;
    }
  }
  async function remove(name) {
    const existing = (await list()).find((queue) => queue.queue_name === name);
    if (!existing) return { name, state: "absent" };
    if (!/^[a-f0-9]{32}$/u.test(existing.queue_id ?? "")) throw new Error("Cloudflare Queue identity is invalid");
    await request(`${endpoint}/${existing.queue_id}`, { method: "DELETE" });
    return { name, state: "deleted" };
  }
  return { ensure, remove };
}

async function main() {
  const [operation, workerName] = process.argv.slice(2);
  if (!workerName || !["ensure", "delete-preview"].includes(operation ?? "")) throw new Error("expected ensure or delete-preview <worker-name>");
  if (operation === "delete-preview" && !/-worker-pr-[1-9][0-9]*$/u.test(workerName)) throw new Error("only isolated preview Queues may be deleted");
  if (!queuesEnabled(await readFile(new URL("../.trestle/project.yaml", import.meta.url), "utf8"))) {
    process.stdout.write("Cloudflare Queues disabled; no resources changed\n");
    return;
  }
  const { primary, deadLetter } = queueNames(workerName);
  const client = queueClient({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", token: process.env.CLOUDFLARE_API_TOKEN ?? "" });
  const names = operation === "ensure" ? [deadLetter, primary] : [primary, deadLetter];
  for (const name of names) {
    const result = operation === "ensure" ? await client.ensure(name) : await client.remove(name);
    process.stdout.write(`${result.state}: ${result.name}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
