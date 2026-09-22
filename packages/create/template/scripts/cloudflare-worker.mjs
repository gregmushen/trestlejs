const [operation, worker] = process.argv.slice(2);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const apiBase = (process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4").replace(/\/$/u, "");

if (operation !== "delete") throw new Error("expected delete");
if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(worker ?? "")) throw new Error("invalid Worker name");
if (!accountId || !token) throw new Error("Cloudflare account ID and API token are required");

const endpoint = `${apiBase}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(worker)}`;
const response = await fetch(endpoint, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
if (!response.ok && response.status !== 404) throw new Error(`Cloudflare Worker request failed with HTTP ${response.status}`);
process.stdout.write(response.status === 404 ? `${worker} already absent\n` : `Deleted ${worker}\n`);
