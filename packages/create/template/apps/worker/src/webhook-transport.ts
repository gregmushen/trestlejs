import { connect as tlsConnect } from "node:tls";

import { approveWebhookAddress, resolveWebhookDestination, validateWebhookDestination, WebhookEgressError, type WebhookDestination } from "./webhook-egress.js";

type NativeWebhookTransportOutcome =
  | { kind: "response"; status: number }
  | { kind: "failure"; category: "timeout" | "network" | "tls" | "blocked_address" };
export type NativeWebhookTransportResult = NativeWebhookTransportOutcome & { durationMs: number };

export type PinnedSocket = {
  onSecureConnect(callback: (authorized: boolean) => void): void;
  onData(callback: (chunk: Uint8Array) => void): void;
  onError(callback: (error: unknown) => void): void;
  onEnd(callback: () => void): void;
  write(bytes: Uint8Array): void;
  destroy(): void;
};

export type PinnedConnector = (input: { address: string; hostname: string; port: number }) => PinnedSocket;

export function connectPinnedTls(input: { address: string; hostname: string; port: number }): PinnedSocket {
  approveWebhookAddress(input.address);
  const socket = tlsConnect({
    host: input.address,
    port: input.port,
    servername: input.hostname,
    rejectUnauthorized: true,
    ALPNProtocols: ["http/1.1"],
  });
  return {
    onSecureConnect: (callback) => { socket.once("secureConnect", () => callback(socket.authorized)); },
    onData: (callback) => { socket.on("data", callback); },
    onError: (callback) => { socket.on("error", callback); },
    onEnd: (callback) => { socket.on("end", callback); },
    write: (bytes) => { socket.write(bytes); },
    destroy: () => { socket.destroy(); },
  };
}

const forbiddenHeaders = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade", "proxy-authorization"]);

/** A single HTTP/1.1 request. Neither fetch nor DNS is used after the pinned
 * connection is chosen, so there is no second resolution or redirect path. */
export function formatPinnedWebhookRequest(input: { destination: WebhookDestination; body: string; headers: Record<string, string> }): Uint8Array {
  validateWebhookDestination(input.destination.url.toString());
  if (typeof input.body !== "string") throw new Error("Invalid webhook request body");
  const body = new TextEncoder().encode(input.body);
  if (body.byteLength > 256 * 1024) throw new Error("Webhook request exceeds the public payload limit");
  const path = `${input.destination.url.pathname}${input.destination.url.search}`;
  const lines = [`POST ${path} HTTP/1.1`, `Host: ${input.destination.url.host}`, "Connection: close", `Content-Length: ${body.byteLength}`];
  for (const [name, value] of Object.entries(input.headers)) {
    const lower = name.toLowerCase();
    if (!/^[A-Za-z0-9-]+$/u.test(name) || forbiddenHeaders.has(lower) || typeof value !== "string" || value.length > 8 * 1024 || /[\r\n\0]/u.test(value)) {
      throw new Error("Invalid webhook request header");
    }
    lines.push(`${name}: ${value}`);
  }
  const head = new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`);
  if (head.byteLength > 16 * 1024) throw new Error("Webhook request headers exceed the limit");
  const request = new Uint8Array(head.byteLength + body.byteLength);
  request.set(head);
  request.set(body, head.byteLength);
  return request;
}

/** Testable transport core. The socket is always opened to an approved IP;
 * TLS SNI/certificate matching uses the original hostname, never that IP. */
export async function postPinnedWebhook(input: {
  destination: WebhookDestination;
  body: string;
  headers: Record<string, string>;
  connect?: PinnedConnector;
  timeoutMs?: number;
  now?: () => number;
}): Promise<NativeWebhookTransportResult> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) throw new Error("Invalid native webhook timeout");
  const request = formatPinnedWebhookRequest(input);
  const address = input.destination.addresses[0];
  if (!address) throw new Error("Pinned webhook destination has no approved address");
  approveWebhookAddress(address);
  const expectedHostname = input.destination.url.hostname.replace(/^\[|\]$/gu, "");
  if (input.destination.hostname !== expectedHostname) throw new Error("Pinned webhook hostname does not match its URL");
  const now = input.now ?? (() => performance.now());
  const started = now();
  return await new Promise<NativeWebhookTransportResult>((resolve) => {
    let socket: PinnedSocket | undefined;
    let settled = false;
    let received = "";
    const finish = (result: NativeWebhookTransportOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve({ ...result, durationMs: Math.max(0, Math.min(30_000, Math.round(now() - started))) });
    };
    const timer = setTimeout(() => finish({ kind: "failure", category: "timeout" }), timeoutMs);
    try {
      socket = (input.connect ?? connectPinnedTls)({ address, hostname: input.destination.hostname, port: input.destination.port });
      socket.onSecureConnect((authorized) => {
        if (settled) return;
        if (!authorized) { finish({ kind: "failure", category: "tls" }); return; }
        try { socket?.write(request); }
        catch { finish({ kind: "failure", category: "network" }); }
      });
      socket.onData((chunk) => {
        if (settled) return;
        received += new TextDecoder("latin1").decode(chunk);
        while (true) {
          const end = received.indexOf("\r\n\r\n");
          if (end < 0) {
            if (received.length > 16 * 1024) finish({ kind: "failure", category: "network" });
            return;
          }
          if (end + 4 > 16 * 1024) { finish({ kind: "failure", category: "network" }); return; }
          const statusLine = received.slice(0, received.indexOf("\r\n"));
          const match = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: |$)/u.exec(statusLine);
          if (!match) { finish({ kind: "failure", category: "network" }); return; }
          const status = Number(match[1]);
          if (status >= 100 && status < 200 && status !== 101) { received = received.slice(end + 4); continue; }
          finish({ kind: "response", status });
          return;
        }
      });
      socket.onError((error) => {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        const certificateFailure = /^(?:ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED)/u.test(code);
        finish({ kind: "failure", category: certificateFailure ? "tls" : "network" });
      });
      socket.onEnd(() => finish({ kind: "failure", category: "network" }));
    } catch { finish({ kind: "failure", category: "network" }); }
  });
}

/** Resolve again for every attempt, then connect only to an approved address. */
export async function sendNativeWebhook(input: {
  destinationUrl: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  connect?: PinnedConnector;
  resolve?: typeof resolveWebhookDestination;
}): Promise<NativeWebhookTransportResult> {
  const started = performance.now();
  let destination: WebhookDestination;
  try { destination = await (input.resolve ?? resolveWebhookDestination)(input.destinationUrl); }
  catch (error) {
    return { kind: "failure", category: error instanceof WebhookEgressError ? "blocked_address" : "network", durationMs: Math.max(0, Math.min(30_000, Math.round(performance.now() - started))) };
  }
  return postPinnedWebhook({ destination, body: input.body, headers: input.headers, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }), ...(input.connect ? { connect: input.connect } : {}) });
}
