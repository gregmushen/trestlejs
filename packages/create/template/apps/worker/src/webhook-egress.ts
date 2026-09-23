import { promises as dns } from "node:dns";
import * as ipaddr from "ipaddr.js";

export class WebhookEgressError extends Error {
  constructor(message: string) { super(message); this.name = "WebhookEgressError"; }
}

export type WebhookDestination = {
  url: URL;
  hostname: string;
  port: number;
  addresses: string[];
};

type Resolver = {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
};

export function approveWebhookAddress(value: string): string {
  if (value.includes("%")) throw new WebhookEgressError("Destination resolved to a non-public address");
  if (!ipaddr.isValid(value)) throw new WebhookEgressError("Destination resolved to an invalid address");
  const parsed = ipaddr.process(value);
  if (parsed.range() !== "unicast") {
    throw new WebhookEgressError("Destination resolved to a non-public address");
  }
  return parsed.toString();
}

/** Validate URL syntax independently of DNS so the same policy can run at
 * endpoint creation and before every outbound attempt. */
export function validateWebhookDestination(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new WebhookEgressError("Invalid webhook destination URL"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new WebhookEgressError("Webhook destination must be HTTPS without credentials or fragments");
  }
  if (url.hostname.endsWith(".")) throw new WebhookEgressError("Webhook destination cannot use a trailing-dot hostname");
  const port = url.port ? Number(url.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new WebhookEgressError("Invalid webhook destination port");
  return url;
}

function dnsMissing(error: unknown): boolean {
  return error instanceof Error && ("code" in error) && ["ENODATA", "ENOTFOUND"].includes(String(error.code));
}

/** Resolve afresh for every attempt; reject the entire answer set if any
 * address is unsafe. The caller must connect only to one of these addresses,
 * while retaining the original hostname for TLS SNI/certificate validation. */
export async function resolveWebhookDestination(raw: string, resolver: Resolver = dns): Promise<WebhookDestination> {
  const url = validateWebhookDestination(raw);
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  const literal = ipaddr.isValid(hostname);
  const addresses = literal ? [hostname] : await Promise.all([
    resolver.resolve4(hostname).catch((error: unknown) => { if (dnsMissing(error)) return []; throw error; }),
    resolver.resolve6(hostname).catch((error: unknown) => { if (dnsMissing(error)) return []; throw error; }),
  ]).then(([ipv4, ipv6]) => [...ipv4, ...ipv6]);
  if (addresses.length === 0) throw new WebhookEgressError("Destination has no resolved addresses");
  const approved = [...new Set(addresses.map(approveWebhookAddress))];
  return { url, hostname, port: url.port ? Number(url.port) : 443, addresses: approved };
}
