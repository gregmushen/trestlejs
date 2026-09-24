import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function verifyCronCapacity({ token, accountId, configPath, environment, plan = "free", apiBase = "https://api.cloudflare.com/client/v4", request = fetch }) {
  if (!token || !/^[a-f0-9]{32}$/iu.test(accountId ?? "")) throw new Error("Cloudflare API token and 32-character account ID are required");
  if (!["staging", "production"].includes(environment)) throw new Error("cron capacity preflight requires staging or production");
  if (!["free", "paid"].includes(plan)) throw new Error("CLOUDFLARE_WORKERS_PLAN must be free or paid");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const target = config.env?.[environment];
  if (!target?.name) throw new Error(`Wrangler ${environment} Worker name is missing`);
  const desired = target.triggers?.crons ?? [];
  if (!Array.isArray(desired)) throw new Error("Wrangler cron triggers must be an array");
  if (desired.length === 0) return { used: 0, desired: 0, limit: plan === "paid" ? 250 : 5, skipped: true };
  const base = apiBase.replace(/\/$/u, "");
  async function get(path, label) {
    const response = await request(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
    const body = await response.json();
    if (body.success !== true) throw new Error(`${label} was not confirmed by Cloudflare`);
    return body;
  }
  const scripts = [];
  for (let page = 1; ; page += 1) {
    if (page > 1000) throw new Error("Cloudflare Worker listing exceeded the safe pagination limit");
    const body = await get(`/accounts/${accountId}/workers/scripts?per_page=100&page=${page}`, "Cloudflare Worker listing");
    if (!Array.isArray(body.result)) throw new Error("Cloudflare Worker listing returned an unexpected result");
    scripts.push(...body.result);
    const pages = body.result_info?.total_pages;
    if (pages !== undefined && (!Number.isInteger(pages) || pages < page)) throw new Error("Cloudflare Worker listing returned invalid pagination");
    if (pages !== undefined ? page >= pages : body.result.length < 100) break;
  }
  let used = 0;
  let existingTarget = 0;
  for (const script of scripts) {
    if (typeof script.id !== "string" || !script.id) throw new Error("Cloudflare Worker listing returned an invalid script ID");
    const body = await get(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(script.id)}/schedules`, "Cloudflare Worker schedules");
    const schedules = body.result?.schedules;
    if (!Array.isArray(schedules)) throw new Error("Cloudflare Worker schedules returned an unexpected result");
    used += schedules.length;
    if (script.id === target.name) existingTarget = schedules.length;
  }
  const limit = plan === "paid" ? 250 : 5;
  const projected = used - existingTarget + desired.length;
  if (projected > limit) throw new Error(`Cloudflare cron capacity insufficient: ${used}/${limit} triggers used, ${existingTarget} on target Worker, ${desired.length} requested. Deployment stopped before remote changes. Free is assumed unless CLOUDFLARE_WORKERS_PLAN=paid is configured; use an account with available cron capacity.`);
  return { used, existingTarget, desired: desired.length, projected, limit };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyCronCapacity({
    token: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    configPath: process.env.TRESTLE_WRANGLER_CONFIG ?? "apps/worker/.trestle-queues.wrangler.jsonc",
    environment: process.env.TRESTLE_CRON_DEPLOY_ENV,
    plan: process.env.CLOUDFLARE_WORKERS_PLAN || "free",
    apiBase: process.env.CLOUDFLARE_API_BASE,
  }).then((result) => {
    process.stdout.write(result.skipped ? "Cloudflare cron capacity check skipped: no cron requested.\n" : `Cloudflare cron capacity verified: ${result.projected}/${result.limit} projected account triggers.\n`);
  }).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
