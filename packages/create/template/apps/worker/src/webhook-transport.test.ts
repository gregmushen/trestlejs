import { afterEach, describe, expect, it, vi } from "vitest";

import { WebhookEgressError, type WebhookDestination } from "./webhook-egress.js";
import { formatPinnedWebhookRequest, postPinnedWebhook, sendNativeWebhook, type PinnedSocket } from "./webhook-transport.js";

const destination: WebhookDestination = {
  url: new URL("https://hooks.example.com:8443/receive?source=app"),
  hostname: "hooks.example.com",
  port: 8443,
  addresses: ["8.8.8.8"],
};

function fakeSocket(response: string, authorized = true) {
  let secure: ((authorized: boolean) => void) | undefined;
  let data: ((chunk: Uint8Array) => void) | undefined;
  let error: ((error: unknown) => void) | undefined;
  let end: (() => void) | undefined;
  const writes: Uint8Array[] = [];
  let destroyed = false;
  const socket: PinnedSocket = {
    onSecureConnect: (callback) => { secure = callback; queueMicrotask(() => secure?.(authorized)); },
    onData: (callback) => { data = callback; },
    onError: (callback) => { error = callback; },
    onEnd: (callback) => { end = callback; },
    write: (bytes) => { writes.push(bytes); queueMicrotask(() => data?.(new TextEncoder().encode(response))); },
    destroy: () => { destroyed = true; },
  };
  return { socket, writes, get destroyed() { return destroyed; }, fail: (reason: unknown) => error?.(reason), close: () => end?.() };
}

afterEach(() => vi.useRealTimers());

describe("pinned native webhook transport", () => {
  it("builds one exact HTTP request with byte-correct body length and no redirect behavior", () => {
    const request = formatPinnedWebhookRequest({ destination, body: JSON.stringify({ name: "café" }), headers: { "webhook-id": "whm_123", "content-type": "application/json" } });
    const wire = new TextDecoder().decode(request);
    expect(wire).toContain("POST /receive?source=app HTTP/1.1\r\nHost: hooks.example.com:8443\r\n");
    expect(wire).toContain("Content-Length: 16\r\n");
    expect(wire).toContain("Connection: close\r\n");
    expect(wire.endsWith('{"name":"café"}')).toBe(true);
    for (const headers of [{ Host: "internal" }, { "content-length": "0" }, { "X-Bad": "one\r\ntwo" }]) {
      expect(() => formatPinnedWebhookRequest({ destination, body: "{}", headers })).toThrow("Invalid webhook request header");
    }
  });

  it("connects only to the approved IP with the original hostname for TLS and accepts a 2xx", async () => {
    const fake = fakeSocket("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n");
    const connect = vi.fn(() => fake.socket);
    expect(await postPinnedWebhook({ destination, body: "{}", headers: {}, connect, now: () => 100 })).toEqual({ kind: "response", status: 204, durationMs: 0 });
    expect(connect).toHaveBeenCalledWith({ address: "8.8.8.8", hostname: "hooks.example.com", port: 8443 });
    expect(fake.writes).toHaveLength(1);
    expect(fake.destroyed).toBe(true);
  });

  it("returns redirects as failures for settlement without following Location", async () => {
    const fake = fakeSocket("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/private\r\n\r\n");
    expect(await postPinnedWebhook({ destination, body: "{}", headers: {}, connect: () => fake.socket })).toMatchObject({ kind: "response", status: 302 });
    expect(fake.writes).toHaveLength(1);
  });

  it("handles interim responses and rejects malformed or excessive response headers", async () => {
    const interim = fakeSocket("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n\r\n");
    expect(await postPinnedWebhook({ destination, body: "{}", headers: {}, connect: () => interim.socket })).toMatchObject({ kind: "response", status: 200 });
    const malformed = fakeSocket("NOT HTTP\r\n\r\n");
    expect(await postPinnedWebhook({ destination, body: "{}", headers: {}, connect: () => malformed.socket })).toMatchObject({ kind: "failure", category: "network" });
    const excessive = fakeSocket(`HTTP/1.1 200 OK\r\nX-Fill: ${"x".repeat(17_000)}\r\n\r\n`);
    expect(await postPinnedWebhook({ destination, body: "{}", headers: {}, connect: () => excessive.socket })).toMatchObject({ kind: "failure", category: "network" });
  });

  it("rejects unauthorized TLS before sending any request and bounds timeout", async () => {
    const unauthorized = fakeSocket("", false);
    expect(await postPinnedWebhook({ destination, body: "{}", headers: {}, connect: () => unauthorized.socket })).toMatchObject({ kind: "failure", category: "tls" });
    expect(unauthorized.writes).toHaveLength(0);
    vi.useFakeTimers();
    const stalled = fakeSocket("");
    const pending = postPinnedWebhook({ destination, body: "{}", headers: {}, connect: () => stalled.socket, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ kind: "failure", category: "timeout" });
    expect(stalled.destroyed).toBe(true);
  });

  it("never writes after an error or timeout wins the connection race", async () => {
    let secure: ((authorized: boolean) => void) | undefined;
    let onError: ((error: unknown) => void) | undefined;
    let writes = 0;
    const socket: PinnedSocket = {
      onSecureConnect: (callback) => { secure = callback; },
      onData: () => undefined,
      onError: (callback) => { onError = callback; },
      onEnd: () => undefined,
      write: () => { writes++; },
      destroy: () => undefined,
    };
    const failed = postPinnedWebhook({ destination, body: "{}", headers: {}, connect: () => socket });
    onError?.(Object.assign(new Error("certificate rejected"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }));
    expect(await failed).toMatchObject({ kind: "failure", category: "tls" });
    secure?.(true);
    expect(writes).toBe(0);
    vi.useFakeTimers();
    const timedOut = postPinnedWebhook({ destination, body: "{}", headers: {}, connect: () => socket, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await timedOut).toMatchObject({ kind: "failure", category: "timeout" });
    secure?.(true);
    expect(writes).toBe(0);
  });

  it("never connects when fresh resolution blocks an unsafe destination", async () => {
    const connect = vi.fn(() => fakeSocket("").socket);
    expect(await sendNativeWebhook({ destinationUrl: destination.url.toString(), body: "{}", headers: {}, connect,
      resolve: async () => { throw new WebhookEgressError("blocked"); },
    })).toMatchObject({ kind: "failure", category: "blocked_address" });
    expect(connect).not.toHaveBeenCalled();
    await expect(postPinnedWebhook({ destination: { ...destination, addresses: ["127.0.0.1"] }, body: "{}", headers: {}, connect })).rejects.toThrow("non-public");
    expect(connect).not.toHaveBeenCalled();
    await expect(sendNativeWebhook({ destinationUrl: destination.url.toString(), body: "{}", headers: {}, connect,
      resolve: async () => destination, timeoutMs: 0,
    })).rejects.toThrow("Invalid native webhook timeout");
    expect(connect).not.toHaveBeenCalled();
  });
});
