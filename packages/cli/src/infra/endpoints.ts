/**
 * Destination validation before any credential is transmitted (spec §17,
 * AR-12). A syntactically valid URL is not enough: the host must belong to the
 * provider, TLS must be required, and no option may redirect the connection.
 */

export type EndpointCheck = Readonly<{ ok: true; host: string } | { ok: false; reason: string }>;

const NEON_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/u;
const FORBIDDEN_POSTGRES_OPTIONS = new Set(["host", "hostaddr", "port", "sslrootcert", "sslcert", "sslkey", "service", "passfile", "options"]);

export function validatePostgresEndpoint(connection: string, provider: "neon"): EndpointCheck {
  let url: URL;
  try {
    url = new URL(connection);
  } catch {
    return { ok: false, reason: "database endpoint is not a URL" };
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return { ok: false, reason: "database endpoint must use the postgres scheme" };
  const host = url.hostname.toLowerCase();
  if (provider === "neon" && !NEON_HOST.test(host)) return { ok: false, reason: "database host is not a Neon endpoint" };
  if (url.port && url.port !== "5432") return { ok: false, reason: "database endpoint uses an unexpected port" };
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode !== "require" && sslmode !== "verify-full") return { ok: false, reason: "database endpoint must require TLS (sslmode=require or verify-full)" };
  for (const key of url.searchParams.keys()) {
    if (FORBIDDEN_POSTGRES_OPTIONS.has(key.toLowerCase())) return { ok: false, reason: `database endpoint option ${key} could redirect or weaken the connection` };
  }
  if (url.searchParams.getAll("sslmode").length > 1) return { ok: false, reason: "database endpoint repeats sslmode" };
  return { ok: true, host };
}

const API_HOSTS: Readonly<Record<string, string>> = Object.freeze({ resend: "api.resend.com", cloudflare: "api.cloudflare.com", neon: "console.neon.tech" });

export function validateApiEndpoint(endpoint: string, provider: keyof typeof API_HOSTS): EndpointCheck {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: "API endpoint is not a URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "API endpoint must use https" };
  if (url.username || url.password) return { ok: false, reason: "API endpoint must not embed credentials" };
  if (url.hostname.toLowerCase() !== API_HOSTS[provider] || (url.port && url.port !== "443")) return { ok: false, reason: `API endpoint is not ${API_HOSTS[provider]}` };
  return { ok: true, host: url.hostname };
}

/** Provider dashboards `trestle infra open` may print; never a provider-supplied URL. */
export const DASHBOARD_URLS: Readonly<Record<string, string>> = Object.freeze({
  neon: "https://console.neon.tech/app/projects",
  cloudflare: "https://dash.cloudflare.com/",
  resend: "https://resend.com/overview",
  "stripe-projects": "https://dashboard.stripe.com/projects",
});
