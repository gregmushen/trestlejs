import type { ApplicationEnvironment } from "@__TRESTLE_PROJECT_NAME__/authz";

export type EndpointState = "active" | "paused" | "disabled";
export type EndpointHealth = "healthy" | "failing" | "untested";
export type DeliveryStatus = "pending" | "succeeded" | "failed" | "cancelled";

/** Consecutive failed attempts after which an endpoint reports as failing and admins are notified. */
export const failingThreshold = 5;

/** Delay before each retry, in seconds. A delivery fails permanently after the last one. */
export const retrySchedule: readonly number[] = [30, 120, 600, 3_600, 21_600];
export const maxAttempts = retrySchedule.length + 1;

export class WebhookDomainError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "conflict", message: string) {
    super(message);
    this.name = "WebhookDomainError";
  }
}

const privateHost = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|localhost$|.*\.local$|.*\.internal$)/iu;

/**
 * Endpoint URLs must be HTTPS on a public host. Local development may also
 * target http://localhost so the built-in receiver can be used.
 */
export function validateEndpointUrl(raw: string, environment: ApplicationEnvironment): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new WebhookDomainError("invalid", "Enter a valid URL"); }
  if (url.username || url.password) throw new WebhookDomainError("invalid", "Endpoint URLs cannot contain credentials");
  if (url.hash) throw new WebhookDomainError("invalid", "Endpoint URLs cannot contain a fragment");
  // Locally, host.docker.internal lets a dispatch provider running in Docker (self-hosted Svix) reach the dev receiver.
  const local = environment === "local" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "host.docker.internal");
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new WebhookDomainError("invalid", "Endpoint URLs must use HTTPS");
  if (!local && privateHost.test(url.hostname)) throw new WebhookDomainError("invalid", "Endpoint URLs must resolve to a public host");
  if (raw.length > 2_000) throw new WebhookDomainError("invalid", "Endpoint URLs must be at most 2,000 characters");
  return url;
}

/** What operators and read models show: origin and path only, never the query string. */
export function sanitizeEndpointUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}${url.search ? "?…" : ""}`;
}

export function endpointHealth(endpoint: Readonly<{ consecutiveFailures: number; lastSuccessAt: Date | null; lastFailureAt: Date | null }>): EndpointHealth {
  if (endpoint.consecutiveFailures >= failingThreshold) return "failing";
  if (!endpoint.lastSuccessAt && !endpoint.lastFailureAt) return "untested";
  return endpoint.consecutiveFailures > 0 && (!endpoint.lastSuccessAt || (endpoint.lastFailureAt && endpoint.lastFailureAt > endpoint.lastSuccessAt)) ? "failing" : "healthy";
}

const transitions: Readonly<Record<EndpointState, readonly EndpointState[]>> = {
  active: ["paused", "disabled"],
  paused: ["active", "disabled"],
  disabled: ["active"],
};

export function assertTransition(from: EndpointState, to: EndpointState): void {
  if (from === to) throw new WebhookDomainError("conflict", `The endpoint is already ${to}`);
  if (!transitions[from].includes(to)) throw new WebhookDomainError("conflict", `An endpoint cannot move from ${from} to ${to}`);
}

/** Completed, non-test deliveries to an active endpoint may be replayed as a new delivery. */
export function replayProblem(delivery: Readonly<{ status: DeliveryStatus; test: boolean }>, endpointState: EndpointState): string | null {
  if (delivery.test) return "Test deliveries cannot be replayed; send a new test event";
  if (delivery.status !== "failed" && delivery.status !== "succeeded") return "Only completed deliveries can be replayed";
  if (endpointState !== "active") return `The endpoint is ${endpointState}; resume it before replaying`;
  return null;
}

export type AttemptOutcome = Readonly<{ responseCode: number | null; failureCategory: string | null; durationMs: number }>;

/** Coarse, payload-free failure categories. Response bodies are never stored. */
/**
 * Whether an address is private, loopback, link-local (cloud metadata),
 * carrier-grade NAT, unspecified, or an IPv4-mapped form of one.
 */
export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/gu, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(value)?.[1];
  const v4 = mapped ?? (/^\d+\.\d+\.\d+\.\d+$/u.test(value) ? value : null);
  if (v4) {
    const [a = 0, b = 0] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return value === "::" || value === "::1" || /^f[cd][0-9a-f]{2}:/u.test(value) || /^fe[89ab][0-9a-f]:/u.test(value);
}

/**
 * Resolves an endpoint's host over DNS-over-HTTPS and refuses private
 * destinations, so a hostname that was public at creation cannot be rebound
 * to an internal or metadata address before delivery. Returns a safe reason
 * when blocked, null when allowed.
 */
export function publicDestinationGuard(fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)) {
  return async (endpointUrl: string): Promise<string | null> => {
    const host = new URL(endpointUrl).hostname;
    if (isPrivateAddress(host)) return "destination is a private address";
    if (/^[\d.]+$|:/u.test(host)) return null;
    const answers: string[] = [];
    for (const type of ["A", "AAAA"]) {
      try {
        const response = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(3_000) });
        const body = await response.json() as { Answer?: Array<{ type: number; data: string }> };
        answers.push(...(body.Answer ?? []).filter((answer) => answer.type === 1 || answer.type === 28).map((answer) => answer.data));
      } catch { return "destination could not be resolved"; }
    }
    if (!answers.length) return "destination does not resolve";
    return answers.some(isPrivateAddress) ? "destination resolves to a private address" : null;
  };
}

export function failureCategory(responseCode: number | null, error?: unknown): string | null {
  if (responseCode !== null) {
    if (responseCode >= 200 && responseCode < 300) return null;
    if (responseCode === 410) return "endpoint_gone";
    if (responseCode === 429) return "rate_limited";
    if (responseCode >= 300 && responseCode < 400) return "redirect_not_followed";
    return responseCode >= 500 ? "endpoint_error" : "endpoint_rejected";
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "connection_failed";
}

/** Next state after an attempt: success, a scheduled retry, or permanent failure. */
export function afterAttempt(attempts: number, outcome: AttemptOutcome, now: Date): { status: DeliveryStatus; nextAttemptAt: Date | null } {
  if (outcome.failureCategory === null) return { status: "succeeded", nextAttemptAt: null };
  // A 410 means the receiver asked us to stop; do not retry it.
  if (outcome.failureCategory === "endpoint_gone" || attempts >= maxAttempts) return { status: "failed", nextAttemptAt: null };
  return { status: "pending", nextAttemptAt: new Date(now.getTime() + retrySchedule[attempts - 1]! * 1_000) };
}
