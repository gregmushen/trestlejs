import type { CredentialStatus } from "./access.js";
import type { PermissionRegistry } from "./registry.js";

/**
 * Scoped API keys for service accounts. A token is shown once at mint time and
 * never stored: the database keeps a SHA-256 verifier and a public ID. Format:
 * `tr_<live|test|dev>_<16-character public ID>_<43-character secret>`.
 */
export type ApplicationEnvironment = "local" | "preview" | "staging" | "production";

export const apiKeyEnvironmentPrefix: Record<ApplicationEnvironment, "live" | "test" | "dev"> = { production: "live", staging: "test", preview: "test", local: "dev" };

const tokenPattern = /^tr_(live|test|dev)_([A-Za-z0-9]{16})_([A-Za-z0-9_-]{43})$/u;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const maximumRotationOverlapHours = 168;

export type MintedApiKey = Readonly<{
  /** Displayed exactly once. Never persisted. */
  token: string;
  publicId: string;
  /** Non-secret presentation, e.g. tr_live_7Ks9Qm2VhX4bLp8N. */
  displayPrefix: string;
  verifier: string;
}>;

type Random = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;

function randomString(length: number, random: Random): string {
  let value = "";
  while (value.length < length) {
    for (const byte of random(new Uint8Array(length * 2))) {
      // Rejection sampling keeps the alphabet uniform.
      if (byte >= 248) continue;
      value += alphabet[byte % alphabet.length];
      if (value.length === length) break;
    }
  }
  return value;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

export async function mintApiKey(environment: ApplicationEnvironment, random: Random = (bytes) => crypto.getRandomValues(bytes)): Promise<MintedApiKey> {
  const prefix = `tr_${apiKeyEnvironmentPrefix[environment]}`;
  const publicId = randomString(16, random);
  const token = `${prefix}_${publicId}_${base64url(random(new Uint8Array(32)))}`;
  return { token, publicId, displayPrefix: `${prefix}_${publicId}`, verifier: await sha256(token) };
}

export function parseApiKey(token: string): Readonly<{ environmentPrefix: "live" | "test" | "dev"; publicId: string }> | null {
  const match = tokenPattern.exec(token);
  return match ? { environmentPrefix: match[1] as "live" | "test" | "dev", publicId: match[2]! } : null;
}

/** The `tr_` token from an `Authorization: Bearer` header, if the request carries one. */
export function bearerApiKey(authorization: string | null | undefined): string | null {
  return /^Bearer\s+(tr_\S+)$/u.exec(authorization ?? "")?.[1] ?? null;
}

export async function verifyApiKey(token: string, verifier: string): Promise<boolean> {
  return constantTimeEqual(await sha256(token), verifier);
}

export type ApiKeyState = Readonly<{ environment: string; expiresAt: Date | null; revokedAt: Date | null; serviceAccountStatus: string }>;

/** Why a verified key may not act now. Checked in this order so the most durable reason wins. */
export function apiKeyStatus(key: ApiKeyState, context: Readonly<{ now: Date; environment: ApplicationEnvironment }>): CredentialStatus {
  if (key.revokedAt && key.revokedAt <= context.now) return "revoked";
  if (key.expiresAt && key.expiresAt <= context.now) return "expired";
  if (key.environment !== context.environment) return "wrong_environment";
  if (key.serviceAccountStatus !== "active") return "service_account_suspended";
  return "active";
}

/** When a rotated key stops working: after the overlap, and never later than it already would have. */
export function rotationExpiry(now: Date, overlapHours = 24, currentExpiry?: Date | null): Date {
  if (!Number.isFinite(overlapHours) || overlapHours < 0 || overlapHours > maximumRotationOverlapHours) throw new Error(`Rotation overlap must be between 0 and ${maximumRotationOverlapHours} hours`);
  const overlapEnds = new Date(now.getTime() + overlapHours * 3_600_000);
  return currentExpiry && currentExpiry < overlapEnds ? currentExpiry : overlapEnds;
}

/**
 * Scopes must be registered application-plane permissions that API keys may
 * hold. A key can never carry organization or platform authority.
 */
export function validateApiKeyScopes(registry: PermissionRegistry, scopes: readonly string[]): string[] {
  const problems: string[] = [];
  if (scopes.length === 0) problems.push("An API key needs at least one scope");
  for (const scope of new Set(scopes)) {
    const permission = registry.get(scope);
    if (!permission) problems.push(`${scope} is not a registered permission`);
    else if (permission.plane !== "application") problems.push(`${scope} is a ${permission.plane} permission; API keys hold application permissions only`);
    else if (!permission.principals.includes("api_key")) problems.push(`${scope} is not available to API keys`);
  }
  return problems;
}
