/** Native webhook destination policy. A transport must connect to the
 * approved address while retaining the URL hostname for TLS SNI and Host.
 * Workers fetch() cannot provide that guarantee for arbitrary domains. */
export class NativeWebhookDestinationError extends Error {
  constructor(message: string) { super(message); this.name = "NativeWebhookDestinationError"; }
}

export type NativeWebhookDestination = Readonly<{
  url: string;
  hostname: string;
  port: number;
}>;

export type PinnedNativeWebhookDestination = NativeWebhookDestination & Readonly<{
  approvedAddress: string;
}>;

export type NativeWebhookResolver = {
  /** Return the final A and AAAA answers, not a CNAME or an untrusted hint. */
  resolveAll(hostname: string): Promise<readonly string[]>;
};

function ipv4(value: string): number[] | null {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

function ipv6(value: string): number[] | null {
  const literal = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (!literal.includes(":") || literal.includes("%")) return null;
  let expanded = literal;
  const lastColon = expanded.lastIndexOf(":");
  if (expanded.slice(lastColon + 1).includes(".")) {
    const tail = ipv4(expanded.slice(lastColon + 1));
    if (!tail) return null;
    expanded = `${expanded.slice(0, lastColon + 1)}${((tail[0]! << 8) | tail[1]!).toString(16)}:${((tail[2]! << 8) | tail[3]!).toString(16)}`;
  }
  const halves = expanded.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (part: string) => part ? part.split(":") : [];
  const left = parseHalf(halves[0]!);
  const right = halves.length === 2 ? parseHalf(halves[1]!) : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/iu.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/iu.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0 || halves.length === 2 && missing < 1) return null;
  return [...left.map((part) => parseInt(part, 16)), ...Array(missing).fill(0), ...right.map((part) => parseInt(part, 16))];
}

/** Strict public-unicast allowlist, including IPv4-mapped and reserved IPv6 rejection. */
export function isPublicWebhookAddress(value: string): boolean {
  const four = ipv4(value);
  if (four) {
    const [a, b, c] = four;
    return !(a === 0 || a === 10 || a === 127 || a! >= 224
      || a === 100 && b! >= 64 && b! <= 127
      || a === 169 && b === 254
      || a === 172 && b! >= 16 && b! <= 31
      || a === 192 && (b === 0 && c === 0 || b === 0 && c === 2 || b === 88 && c === 99 || b === 168)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113);
  }
  const six = ipv6(value);
  if (!six) return false;
  // Restrict to global unicast and exclude IANA special-purpose blocks.
  // Be conservative: rejecting an unusual legitimate destination is safer
  // than admitting a transition mechanism that can reach a private IPv4 host.
  return six[0]! >= 0x2000 && six[0]! <= 0x3fff
    && !(six[0] === 0x2001 && (six[1]! <= 0x01ff || six[1] === 0x0db8))
    && six[0] !== 0x2002 // 6to4 embeds an IPv4 destination.
    && six[0] !== 0x3fff; // documentation space.
}

/** Parse at both endpoint creation and immediately before each attempt. */
export function parseNativeWebhookDestination(input: string): NativeWebhookDestination {
  if (typeof input !== "string" || !input || input.length > 2048 || /[\u0000-\u001f\u007f]/u.test(input)) throw new NativeWebhookDestinationError("Invalid webhook destination URL");
  let url: URL;
  try { url = new URL(input); }
  catch { throw new NativeWebhookDestinationError("Invalid webhook destination URL"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) throw new NativeWebhookDestinationError("Webhook destination must be an HTTPS URL without credentials or a fragment");
  const hostname = url.hostname.replace(/\.$/u, "").toLowerCase();
  if (!hostname || hostname.endsWith(".localhost") || hostname === "localhost"
    || /\.(?:local|internal|test|invalid)$/u.test(hostname) || (!hostname.includes(".") && !hostname.startsWith("["))) {
    throw new NativeWebhookDestinationError("Webhook destination hostname is not public");
  }
  if (hostname.startsWith("[") ? !isPublicWebhookAddress(hostname) : ipv4(hostname) && !isPublicWebhookAddress(hostname)) {
    throw new NativeWebhookDestinationError("Webhook destination address is not public");
  }
  url.hostname = hostname;
  const port = url.port ? Number(url.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new NativeWebhookDestinationError("Webhook destination port is invalid");
  return { url: url.toString(), hostname, port };
}

/** Must be called afresh for every attempt; no DNS answer is cached across retries. */
export async function resolveNativeWebhookDestination(input: string, resolver: NativeWebhookResolver): Promise<PinnedNativeWebhookDestination> {
  const destination = parseNativeWebhookDestination(input);
  const answers = destination.hostname.startsWith("[") || ipv4(destination.hostname)
    ? [destination.hostname.startsWith("[") ? destination.hostname.slice(1, -1) : destination.hostname]
    : await resolver.resolveAll(destination.hostname);
  if (!answers.length || answers.length > 32 || answers.some((answer) => !isPublicWebhookAddress(answer))) {
    throw new NativeWebhookDestinationError("Webhook destination DNS did not resolve exclusively to public addresses");
  }
  return { ...destination, approvedAddress: answers[0]! };
}
