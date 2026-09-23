import type { CapabilityId, EnvironmentName, EvidenceDocument } from "@trestlejs/core";

export type ConnectionProvider = "resend" | "stripe" | "neon" | "lago" | "workos" | "openmeter" | "svix";
export type ConnectionStatus = "reachable" | "unauthorized" | "unreachable" | "not_configured";
export type ConnectionResult = { provider: ConnectionProvider; ok: boolean; status: ConnectionStatus; checkedAt: string };

/**
 * A self-hosted or regional base URL from the credential document. Only HTTPS
 * (or plain HTTP on loopback, for a local provider) without embedded
 * credentials is accepted; anything else falls back to the hosted API.
 */
export function providerBaseUrl(configured: string | undefined, hosted: string): string {
  try {
    if (configured) {
      const parsed = new URL(configured);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
      if ((parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)) && !parsed.username && !parsed.password) return parsed.origin + parsed.pathname.replace(/\/+$/u, "");
    }
  } catch { /* fall back to the hosted API */ }
  return hosted;
}

export const connectionProviders: Record<ConnectionProvider, { secret: string; url: (values: Record<string, string>) => string }> = {
  resend: { secret: "RESEND_API_KEY", url: () => "https://api.resend.com/domains" },
  stripe: { secret: "STRIPE_SECRET_KEY", url: () => "https://api.stripe.com/v1/balance" },
  neon: { secret: "NEON_API_KEY", url: () => "https://console.neon.tech/api/v2/projects?limit=1" },
  lago: { secret: "LAGO_API_KEY", url: (values) => `${providerBaseUrl(values.LAGO_API_URL, "https://api.getlago.com")}/api/v1/organizations` },
  workos: { secret: "WORKOS_API_KEY", url: () => "https://api.workos.com/organizations?limit=1" },
  openmeter: { secret: "OPENMETER_API_KEY", url: (values) => `${providerBaseUrl(values.OPENMETER_URL, "https://openmeter.cloud")}/api/v1/meters` },
  svix: { secret: "SVIX_API_KEY", url: (values) => `${providerBaseUrl(values.SVIX_SERVER_URL, "https://api.svix.com")}/api/v1/app?limit=1` },
};

export function isConnectionProvider(value: unknown): value is ConnectionProvider {
  return typeof value === "string" && Object.hasOwn(connectionProviders, value);
}

export async function testConnection(
  provider: ConnectionProvider,
  values: Record<string, string> | undefined,
  fetcher: typeof fetch,
  now: () => Date,
  timeoutMs = 10_000,
): Promise<ConnectionResult> {
  const definition = connectionProviders[provider];
  const credential = values?.[definition.secret];
  const result = (status: ConnectionStatus): ConnectionResult => ({ provider, ok: status === "reachable", status, checkedAt: now().toISOString() });
  if (!values || !credential) return result("not_configured");
  try {
    const response = await fetcher(definition.url(values), {
      method: "GET",
      headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) return result("unauthorized");
    return result(response.ok ? "reachable" : "unreachable");
  } catch {
    return result("unreachable");
  }
}

/** The capability each provider connection is evidence for. Neon provisions databases and has no capability of its own. */
export const connectionCapability: Record<ConnectionProvider, CapabilityId | null> = {
  resend: "email", stripe: "payments", lago: "payments", neon: null, workos: "sso", openmeter: "metering", svix: "webhooks",
};

const safeFailure: Record<ConnectionStatus, string | undefined> = {
  reachable: undefined,
  unauthorized: "The provider rejected the credential",
  unreachable: "The provider API could not be reached",
  not_configured: "No credential is stored for this environment",
};

/** Folds this session's connection results into the evidence document; results for other capabilities are kept. */
export function providerCheckEvidence(previous: EvidenceDocument | undefined, environment: EnvironmentName, results: ReadonlyMap<string, ConnectionResult>): Pick<EvidenceDocument, "providerChecks"> {
  const checks: NonNullable<EvidenceDocument["providerChecks"]> = { ...(previous?.environment === environment ? previous.providerChecks : {}) };
  for (const [key, result] of results) {
    const capability = connectionCapability[result.provider];
    if (!key.startsWith(`${environment}:`) || !capability) continue;
    const failure = safeFailure[result.status];
    checks[capability] = { provider: result.provider, ok: result.ok, checkedAt: result.checkedAt, ...(failure ? { failure } : {}) };
  }
  return Object.keys(checks).length ? { providerChecks: checks } : {};
}
