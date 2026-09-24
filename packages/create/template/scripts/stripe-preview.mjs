import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const events = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

export function previewWebhookUrl(apiUrl) {
  const url = new URL(apiUrl);
  if (url.protocol !== "https:" || !/^[a-z0-9-]+-worker-pr-[1-9][0-9]*\.[a-z0-9-]+\.workers\.dev$/u.test(url.hostname) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("expected an isolated preview Worker HTTPS origin");
  }
  return `${url.origin}/webhooks/stripe`;
}

export function secretPutArguments(apiUrl) {
  previewWebhookUrl(apiUrl);
  // --env appends an environment suffix even when --name is explicit; the
  // generated preview deploy targets the exact, unsuffixed PR Worker name.
  const workerName = new URL(apiUrl).hostname.split(".")[0];
  return ["exec", "wrangler", "secret", "put", "STRIPE_WEBHOOK_SECRET", "--config", ".trestle-queues.wrangler.jsonc", "--name", workerName];
}

export function stripePreviewClient({ apiKey, fetcher = fetch }) {
  if (!/^(?:sk|rk)_test_[A-Za-z0-9]+$/u.test(apiKey ?? "")) throw new Error("a Stripe test-mode server key is required");
  const headers = { authorization: `Bearer ${apiKey}` };
  async function request(path, options = {}) {
    const response = await fetcher(`https://api.stripe.com/v1/webhook_endpoints${path}`, { ...options, headers: { ...headers, ...options.headers } });
    if (!response.ok) throw new Error(`Stripe webhook request failed with HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error("Stripe webhook request was rejected");
    return body;
  }
  async function list() {
    const result = [];
    let cursor;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("starting_after", cursor);
      const body = await request(`?${query}`);
      if (!Array.isArray(body.data)) throw new Error("Stripe webhook list returned an invalid result");
      result.push(...body.data);
      if (!body.has_more) return result;
      cursor = body.data.at(-1)?.id;
      if (!/^we_[A-Za-z0-9]+$/u.test(cursor ?? "")) throw new Error("Stripe webhook pagination identity is invalid");
    } while (true);
  }
  async function create(url, idempotencyKey) {
    const body = new URLSearchParams({ url, description: "Trestle isolated preview billing webhook" });
    for (const event of events) body.append("enabled_events[]", event);
    const endpoint = await request("", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      body,
    });
    if (!/^we_[A-Za-z0-9]+$/u.test(endpoint.id ?? "") || !/^whsec_[A-Za-z0-9]+$/u.test(endpoint.secret ?? "") || endpoint.url !== url || endpoint.livemode !== false) {
      throw new Error("Stripe did not return a valid test webhook and signing secret");
    }
    return endpoint;
  }
  async function remove(id) {
    if (!/^we_[A-Za-z0-9]+$/u.test(id)) throw new Error("Stripe webhook identity is invalid");
    await request(`/${id}`, { method: "DELETE" });
  }
  return { list, create, remove };
}

export async function provisionPreviewWebhook({ client, apiUrl, putSecret, idempotencyKey }) {
  const url = previewWebhookUrl(apiUrl);
  const prior = (await client.list()).filter((endpoint) => endpoint.url === url && endpoint.livemode === false);
  const created = await client.create(url, idempotencyKey);
  try {
    await putSecret(created.secret);
  } catch (error) {
    await client.remove(created.id).catch(() => {});
    throw error;
  }
  for (const endpoint of prior) if (endpoint.id !== created.id) await client.remove(endpoint.id);
  return { id: created.id, url, state: "provisioned" };
}

export async function removePreviewWebhook({ client, apiUrl }) {
  const url = previewWebhookUrl(apiUrl);
  const matches = (await client.list()).filter((endpoint) => endpoint.url === url && endpoint.livemode === false);
  for (const endpoint of matches) await client.remove(endpoint.id);
  return { url, removed: matches.length };
}

async function main() {
  const [operation, apiUrl] = process.argv.slice(2);
  if (!["provision", "delete"].includes(operation) || !apiUrl) throw new Error("expected provision|delete <isolated-preview-api-url>");
  const client = stripePreviewClient({ apiKey: process.env.STRIPE_SECRET_KEY });
  if (operation === "delete") {
    const result = await removePreviewWebhook({ client, apiUrl });
    process.stdout.write(`Removed ${result.removed} isolated Stripe preview webhook(s)\n`);
    return;
  }
  const putSecret = async (secret) => {
    if (!/^whsec_[A-Za-z0-9]+$/u.test(secret)) throw new Error("Stripe webhook signing secret is invalid");
    if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::add-mask::${secret}\n`);
    const workerDirectory = fileURLToPath(new URL("../apps/worker/", import.meta.url));
    const result = spawnSync("pnpm", secretPutArguments(apiUrl), {
      cwd: workerDirectory, env: process.env, input: secret, encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`Could not bind preview Stripe webhook secret (exit ${result.status ?? "unknown"})`);
  };
  const runIdentity = [process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT].filter(Boolean).join("-");
  const idempotencyKey = runIdentity ? `trestle-preview-webhook-${new URL(apiUrl).hostname.split(".")[0]}-${runIdentity}` : undefined;
  const result = await provisionPreviewWebhook({ client, apiUrl, putSecret, idempotencyKey });
  process.stdout.write(`Provisioned Stripe test webhook ${result.id} for ${result.url}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
