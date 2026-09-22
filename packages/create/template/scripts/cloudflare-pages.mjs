const [operation, project] = process.argv.slice(2);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const apiBase = (process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4").replace(/\/$/u, "");

if (!['ensure', 'delete'].includes(operation ?? '')) throw new Error("expected ensure or delete");
if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(project ?? "")) throw new Error("invalid Pages project name");
if (!accountId || !token) throw new Error("Cloudflare account ID and API token are required");

const endpoint = `${apiBase}/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(project)}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const wait = async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds));

async function request(url, options = {}, retries = 2) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
    if (response.ok || response.status === 404) return response;
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      await wait(250 * (2 ** attempt));
      continue;
    }
    const credentialHint = response.status === 401 || response.status === 403
      ? "; verify the account ID and a non-expired token with Cloudflare Pages write permission"
      : "";
    throw new Error(`Cloudflare Pages request failed with HTTP ${response.status}${credentialHint}`);
  }
}

if (operation === "ensure") {
  const existing = await request(endpoint);
  if (existing.status === 404) {
    try {
      await request(`${apiBase}/accounts/${encodeURIComponent(accountId)}/pages/projects`, {
        method: "POST",
        body: JSON.stringify({ name: project, production_branch: "main" }),
      }, 0);
      process.stdout.write(`Created ${project}\n`);
    } catch (error) {
      // A timed-out or failed create response may still have committed remotely.
      const reconciled = await request(endpoint);
      if (reconciled.status === 404) throw error;
      process.stdout.write(`Reusing ${project}\n`);
    }
  } else {
    process.stdout.write(`Reusing ${project}\n`);
  }
} else {
  const deleted = await request(endpoint, { method: "DELETE" });
  process.stdout.write(deleted.status === 404 ? `${project} already absent\n` : `Deleted ${project}\n`);
}
