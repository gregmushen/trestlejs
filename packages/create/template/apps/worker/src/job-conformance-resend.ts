import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type RecordedEmail = Readonly<{ id: string; to: string[]; subject: string; headers: Record<string, string>; idempotencyKey: string | null; receivedAt: number }>;

/**
 * A recorded fake of Resend's send endpoint at the HTTP boundary, for the
 * conformance suite: the real Resend adapter posts to it. Like Resend, a
 * request with an idempotency key it already accepted returns the first
 * email's ID and sends nothing. A recipient containing `+drop` has the first
 * response for each key lost (the email is accepted, the caller sees a 500),
 * as a timeout after Resend accepted would look.
 */
export async function startRecordedResend(): Promise<{ url: string; emails(to?: string): RecordedEmail[]; requests(idempotencyKey: string): number; close(): Promise<void> }> {
  const emails: RecordedEmail[] = [];
  const byKey = new Map<string, string>();
  const requests = new Map<string, number>();
  const dropped = new Set<string>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const reply = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.method !== "POST" || request.url !== "/emails") return reply(404, { name: "not_found", message: "Not found", statusCode: 404 });
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { to: string | string[]; subject: string; headers?: Record<string, string> };
    const key = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : null;
    if (key) requests.set(key, (requests.get(key) ?? 0) + 1);
    const to = Array.isArray(body.to) ? body.to : [body.to];
    let id = key ? byKey.get(key) : undefined;
    if (!id) {
      id = `re_${crypto.randomUUID()}`;
      if (key) byKey.set(key, id);
      emails.push({ id, to, subject: body.subject, headers: body.headers ?? {}, idempotencyKey: key, receivedAt: Date.now() });
    }
    if (key && to.some((address) => address.includes("+drop")) && !dropped.has(key)) {
      dropped.add(key);
      return reply(500, { name: "internal_server_error", message: "Response lost", statusCode: 500 });
    }
    return reply(200, { id });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    emails: (to) => emails.filter((email) => !to || email.to.includes(to)),
    requests: (key) => requests.get(key) ?? 0,
    close: async () => { await new Promise((resolve) => server.close(resolve)); },
  };
}
