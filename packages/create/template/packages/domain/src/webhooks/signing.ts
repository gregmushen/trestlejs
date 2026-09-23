/**
 * Standard Webhooks signing (https://www.standardwebhooks.com): the signature
 * is HMAC-SHA256 over `${id}.${timestamp}.${body}` with the endpoint secret.
 * During a rotation overlap both the new and previous secrets sign, so
 * receivers can accept either.
 */
const encoder = new TextEncoder();
const base64 = (bytes: ArrayBuffer | Uint8Array): string => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unbase64 = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

export function generateSigningSecret(): string {
  return `whsec_${base64(crypto.getRandomValues(new Uint8Array(24)))}`;
}

/** Eight hex characters that identify a secret without revealing it. */
export async function secretFingerprint(secret: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret)));
  return [...digest.slice(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signPayload(secrets: readonly string[], id: string, timestamp: number, body: string): Promise<string> {
  const signatures: string[] = [];
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey("raw", unbase64(secret.replace(/^whsec_/u, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    signatures.push(`v1,${base64(await crypto.subtle.sign("HMAC", key, encoder.encode(`${id}.${timestamp}.${body}`)))}`);
  }
  return signatures.join(" ");
}

export async function verifySignature(secret: string, id: string, timestamp: number, body: string, header: string): Promise<boolean> {
  const [expected] = (await signPayload([secret], id, timestamp, body)).split(" ");
  return header.split(" ").includes(expected!);
}

/**
 * Signing secrets are stored encrypted (AES-GCM) under a key derived with HKDF
 * from the Worker's WEBHOOK_SECRET_KEY. The platform database role cannot read
 * the ciphertext column at all.
 */
export async function secretCipher(keyMaterial: string) {
  if (keyMaterial.length < 32) throw new Error("WEBHOOK_SECRET_KEY must be at least 32 characters");
  const base = await crypto.subtle.importKey("raw", encoder.encode(keyMaterial), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("trestle.webhooks"), info: encoder.encode("signing-secret:v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return {
    async encrypt(secret: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      return `v1:${base64(iv)}:${base64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(secret)))}`;
    },
    async decrypt(ciphertext: string): Promise<string> {
      const [version, iv, data] = ciphertext.split(":");
      if (version !== "v1" || !iv || !data) throw new Error("Unsupported webhook secret ciphertext");
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(iv) }, key, unbase64(data)));
    },
  };
}

export type SecretCipher = Awaited<ReturnType<typeof secretCipher>>;

/**
 * The key that encrypts signing secrets at rest. Staging and production need
 * a dedicated WEBHOOK_SECRET_KEY (shared by the customer and admin Workers so
 * either can issue a new secret; neither ever reveals an existing one).
 */
export function webhookKeyMaterial(environment: Readonly<{ WEBHOOK_SECRET_KEY?: string; APP_ENV?: string; BETTER_AUTH_SECRET: string }>): string {
  if (environment.WEBHOOK_SECRET_KEY) return environment.WEBHOOK_SECRET_KEY;
  const runtime = environment.APP_ENV ?? "local";
  if (runtime !== "local" && runtime !== "preview") throw new Error(`WEBHOOK_SECRET_KEY is required in ${runtime}. Run: pnpm exec trestle setup --env ${runtime}`);
  return `derived:${environment.BETTER_AUTH_SECRET}`;
}
