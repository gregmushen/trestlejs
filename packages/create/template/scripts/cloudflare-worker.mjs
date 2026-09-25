const [operation, worker] = process.argv.slice(2);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const apiBase = (process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4").replace(/\/$/u, "");

if (!["delete", "delete-preview"].includes(operation ?? "")) throw new Error("expected delete or delete-preview");
if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(worker ?? "")) throw new Error("invalid Worker name");
if (operation === "delete-preview" && !/-worker-pr-[1-9][0-9]*$/u.test(worker)) throw new Error("only isolated preview Workers may be detached");
if (!accountId || !token) throw new Error("Cloudflare account ID and API token are required");

const account = `${apiBase}/accounts/${encodeURIComponent(accountId)}`;
const endpoint = `${account}/workers/scripts/${encodeURIComponent(worker)}`;
const headers = { authorization: `Bearer ${token}` };

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cloudflare Worker request failed with HTTP ${response.status}`);
  if (response.status === 204) return { success: true };
  const body = await response.json();
  if (body.success !== true) throw new Error("Cloudflare Worker API rejected the request");
  return body;
}

async function previewQueueIds() {
  const queues = [];
  for (let page = 1; ; page += 1) {
    const response = await request(`${account}/queues?page=${page}&per_page=100`);
    if (!Array.isArray(response?.result)) throw new Error("Cloudflare Queue list returned an invalid result");
    queues.push(...response.result);
    if (page >= (response.result_info?.total_pages ?? 1)) return queues;
  }
}

if (operation === "delete-preview") {
  const settings = await request(`${endpoint}/settings`);
  if (settings) {
    const bindings = settings.result?.bindings;
    if (!Array.isArray(bindings)) throw new Error("Cloudflare Worker settings returned invalid bindings");
    const queueBindings = bindings.filter((binding) => binding.type === "queue");
    if (queueBindings.some((binding) => binding.queue_name !== `${worker}-events`)) {
      throw new Error("Preview Worker has an unexpected Queue binding; refusing to detach it");
    }
    const queues = await previewQueueIds();
    const queue = queues.find((item) => item.queue_name === `${worker}-events`);
    if (queue) {
      const consumers = await request(`${account}/queues/${encodeURIComponent(queue.queue_id)}/consumers`);
      if (!Array.isArray(consumers?.result)) throw new Error("Cloudflare Queue consumers returned an invalid result");
      for (const consumer of consumers.result.filter((item) => item.script === worker)) {
        await request(`${account}/queues/${encodeURIComponent(queue.queue_id)}/consumers/${encodeURIComponent(consumer.consumer_id)}`, { method: "DELETE" });
      }
    }
    if (queueBindings.length) {
      const form = new FormData();
      form.set("settings", JSON.stringify({ bindings: [] }));
      await request(`${endpoint}/settings`, { method: "PATCH", body: form });
    }
  }
}

const response = await fetch(endpoint, { method: "DELETE", headers });
if (!response.ok && response.status !== 404) throw new Error(`Cloudflare Worker request failed with HTTP ${response.status}`);
process.stdout.write(response.status === 404 ? `${worker} already absent\n` : `Deleted ${worker}\n`);
