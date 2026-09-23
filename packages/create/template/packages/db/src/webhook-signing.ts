export class WebhookSigningError extends Error {
  constructor(message: string) { super(message); this.name = "WebhookSigningError"; }
}

export function decodeWebhookSigningSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) throw new WebhookSigningError("Webhook signing secret must use the whsec_ format");
  try {
    const encoded = secret.slice(6);
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    if (bytes.length < 16 || btoa(String.fromCharCode(...bytes)) !== encoded) throw new Error("Invalid key material");
    return bytes;
  } catch {
    throw new WebhookSigningError("Webhook signing secret has invalid base64 key material");
  }
}

export async function signWebhookPayload(id: string, timestamp: number, body: string, keyBytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (!/^whm_[A-Za-z0-9_-]+$/u.test(id) || !Number.isSafeInteger(timestamp) || timestamp < 0 || typeof body !== "string") {
    throw new WebhookSigningError("Invalid webhook signing input");
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...bytes))}`;
}

export async function createSignedWebhookHeaders(input: { secret: string; messageId: string; body: string; now: Date }) {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) throw new WebhookSigningError("Invalid webhook signing clock");
  const timestamp = Math.floor(input.now.getTime() / 1_000);
  return {
    "content-type": "application/json",
    "webhook-id": input.messageId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": await signWebhookPayload(input.messageId, timestamp, input.body, decodeWebhookSigningSecret(input.secret)),
  };
}
