const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const apiBase = (process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4").replace(/\/$/u, "");

if (!token || !accountId) throw new Error("Cloudflare API token and account ID are required before deployment");
if (!/^[a-f0-9]{32}$/iu.test(accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID");

async function check(endpoint, label) {
  const response = await fetch(`${apiBase}${endpoint}`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${label} rejected the configured Cloudflare token (HTTP ${response.status}); replace the environment secret with an active account-scoped token that can manage Workers and Pages`);
  }
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  const body = await response.json();
  if (body.success !== true) throw new Error(`${label} did not confirm Cloudflare access`);
  return body;
}

const verification = await check("/user/tokens/verify", "Cloudflare token verification");
if (verification.result?.status !== "active") throw new Error("Cloudflare token is not active");
await check(`/accounts/${accountId}/pages/projects?per_page=1`, "Cloudflare Pages account access");
await check(`/accounts/${accountId}/workers/scripts`, "Cloudflare Workers account access");
process.stdout.write("Cloudflare token, Pages, and Workers account access verified; credential values were not printed.\n");
