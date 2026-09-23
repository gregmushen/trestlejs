/// <reference types="node" />
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateSigningSecret, verifySignature } from "./signing.js";
import { SvixWebhookTransport } from "./svix.js";
import type { TransportRequest } from "./transport.js";

/**
 * Runs against a real Svix server (self-hosted `svix/svix-server`, or the
 * hosted API). TRESTLE_SVIX_TEST_URL and TRESTLE_SVIX_TEST_TOKEN select it;
 * TRESTLE_SVIX_TEST_RECEIVER_HOST is how that server reaches this machine
 * (host.docker.internal for a local container).
 */
const serverUrl = process.env.TRESTLE_SVIX_TEST_URL;
const token = process.env.TRESTLE_SVIX_TEST_TOKEN;
const receiverHost = process.env.TRESTLE_SVIX_TEST_RECEIVER_HOST ?? "localhost";
const suite = serverUrl && token ? describe : describe.skip;

type Received = { headers: IncomingHttpHeaders; body: string };
const received: Received[] = [];
const receiver = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += String(chunk); });
  req.on("end", () => { received.push({ headers: req.headers, body }); res.writeHead(204).end(); });
});
const waitFor = async <T>(check: () => T | undefined, timeoutMs = 20_000): Promise<T> => {
  const started = Date.now();
  for (;;) { const value = check(); if (value !== undefined) return value; if (Date.now() - started > timeoutMs) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 250)); }
};

suite("Svix dispatch against a real Svix server", () => {
  const run = `trestle${Date.now()}`;
  let request: TransportRequest;
  beforeAll(async () => {
    await new Promise<void>((resolve) => receiver.listen(0, "0.0.0.0", resolve));
    const port = (receiver.address() as AddressInfo).port;
    const payload = { type: "project.created", data: { id: "p1" } };
    request = {
      organizationId: `${run}-org`, deliveryId: `${run}-delivery-1`, eventId: `${run}-event-1`, eventName: "project.created",
      endpoint: { id: `${run}-endpoint`, url: `http://${receiverHost}:${port}/hooks`, events: ["project.created"] },
      secrets: [generateSigningSecret()], body: JSON.stringify(payload), payload, timestamp: Math.floor(Date.now() / 1000), timeoutMs: 10_000,
    };
  });
  afterAll(() => { receiver.close(); });

  it("mirrors the endpoint, hands off the delivery, and the endpoint receives a body signed with the Trestle secret", async () => {
    const transport = new SvixWebhookTransport({ apiKey: token!, serverUrl: serverUrl! });
    const result = await transport.send(request);
    expect(result.responseCode).toBe(202);
    expect(result.providerReference).toMatch(/^msg_/u);
    const delivered = await waitFor(() => received.find((entry) => entry.body.includes("project.created")));
    expect(JSON.parse(delivered.body)).toEqual(request.payload);
    const id = String(delivered.headers["svix-id"] ?? delivered.headers["webhook-id"]);
    const timestamp = Number(delivered.headers["svix-timestamp"] ?? delivered.headers["webhook-timestamp"]);
    const signature = String(delivered.headers["svix-signature"] ?? delivered.headers["webhook-signature"]);
    expect(await verifySignature(request.secrets[0]!, id, timestamp, delivered.body, signature)).toBe(true);
  }, 30_000);

  it("deduplicates a retried hand-off of the same delivery", async () => {
    const transport = new SvixWebhookTransport({ apiKey: token!, serverUrl: serverUrl! });
    const first = await transport.send({ ...request, deliveryId: `${run}-delivery-2` });
    const again = await transport.send({ ...request, deliveryId: `${run}-delivery-2` });
    expect(first.responseCode).toBe(202);
    expect([202, 409]).toContain(again.responseCode);
    if (again.providerReference) expect(again.providerReference).toBe(first.providerReference);
  }, 30_000);

  it("follows a Trestle secret rotation so deliveries verify with the new secret", async () => {
    const rotated = { ...request, deliveryId: `${run}-delivery-3`, secrets: [generateSigningSecret(), request.secrets[0]!], payload: { type: "project.created", data: { id: "p3" } } };
    const result = await new SvixWebhookTransport({ apiKey: token!, serverUrl: serverUrl! }).send(rotated);
    expect(result.responseCode).toBe(202);
    const delivered = await waitFor(() => received.find((entry) => entry.body.includes("\"p3\"")));
    const id = String(delivered.headers["svix-id"]);
    const signature = String(delivered.headers["svix-signature"]);
    expect(await verifySignature(rotated.secrets[0]!, id, Number(delivered.headers["svix-timestamp"]), delivered.body, signature)).toBe(true);
  }, 30_000);
});
