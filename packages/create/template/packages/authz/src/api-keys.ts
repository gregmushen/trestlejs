import type { CredentialStatus } from "./access.js";
import type { PermissionRegistry } from "./registry.js";
import type { EffectivePermissions } from "./roles.js";

export type ApplicationEnvironment = "local" | "preview" | "staging" | "production";

export const apiKeyEnvironmentPrefix: Record<ApplicationEnvironment, "live" | "test" | "dev"> = {
  production: "live",
  staging: "test",
  preview: "test",
  local: "dev",
};

const tokenPattern = /^tr_(live|test|dev)_([A-Za-z0-9]{16})_([A-Za-z0-9_-]{43})$/u;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const maximumRotationOverlapHours = 168;

export type MintedApiKey = Readonly<{
  /** Displayed exactly once. Never persisted. */
  token: string;
  publicId: string;
  /** Non-secret identifier presentation, e.g. tr_live_7Ks9Qm2VhX4bLp8N. */
  displayPrefix: string;
  verifier: string;
}>;

export type ApiKeyRecord = Readonly<{
  id: string;
  organizationId: string;
  serviceAccountId: string;
  environment: ApplicationEnvironment;
  scopes: readonly string[];
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  allowedCidrs?: readonly string[] | null;
}>;

function randomString(length: number, random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>): string {
  const bytes = random(new Uint8Array(length * 2));
  let value = "";
  for (const byte of bytes) {
    if (byte >= 248) continue;
    value += alphabet[byte % alphabet.length];
    if (value.length === length) return value;
  }
  return value + randomString(length - value.length, random);
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

export async function mintApiKey(environment: ApplicationEnvironment, random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (bytes) => crypto.getRandomValues(bytes)): Promise<MintedApiKey> {
  const prefix = `tr_${apiKeyEnvironmentPrefix[environment]}`;
  const publicId = randomString(16, random);
  const token = `${prefix}_${publicId}_${base64url(random(new Uint8Array(32)))}`;
  return { token, publicId, displayPrefix: `${prefix}_${publicId}`, verifier: await sha256(token) };
}

export function parseApiKey(token: string): { environmentPrefix: "live" | "test" | "dev"; publicId: string } | null {
  const match = tokenPattern.exec(token);
  return match ? { environmentPrefix: match[1] as "live" | "test" | "dev", publicId: match[2]! } : null;
}

export function bearerApiKey(authorization: string | null | undefined): string | null {
  const match = /^Bearer\s+(tr_\S+)$/u.exec(authorization ?? "");
  return match?.[1] ?? null;
}

export async function verifyApiKey(token: string, verifier: string): Promise<boolean> {
  return constantTimeEqual(await sha256(token), verifier);
}

function parseAddress(value: string): { family: 4 | 6; bits: bigint } | null {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)) {
    const octets = value.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    return { family: 4, bits: octets.reduce((total, octet) => (total << 8n) | BigInt(octet), 0n) };
  }
  if (!value.includes(":")) return null;
  const [head = "", tail, extra] = value.split("::");
  if (extra !== undefined) return null;
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  if (groups.some((group) => !/^[0-9a-fA-F]{1,4}$/u.test(group))) return null;
  return { family: 6, bits: groups.reduce((total, group) => (total << 16n) | BigInt(Number.parseInt(group, 16)), 0n) };
}

export function isValidCidr(cidr: string): boolean {
  const [address = "", length] = cidr.split("/");
  const parsed = parseAddress(address);
  const bits = Number(length);
  return Boolean(parsed) && length !== undefined && Number.isInteger(bits) && bits >= 0 && bits <= (parsed!.family === 4 ? 32 : 128);
}

export function ipAllowed(ip: string | null | undefined, cidrs: readonly string[] | null | undefined): boolean {
  if (!cidrs || cidrs.length === 0) return true;
  const client = ip ? parseAddress(ip) : null;
  if (!client) return false;
  return cidrs.some((cidr) => {
    if (!isValidCidr(cidr)) return false;
    const [address = "", length = "0"] = cidr.split("/");
    const network = parseAddress(address)!;
    if (network.family !== client.family) return false;
    const width = BigInt(client.family === 4 ? 32 : 128);
    const shift = width - BigInt(length);
    return (network.bits >> shift) === (client.bits >> shift);
  });
}

export function apiKeyStatus(
  key: ApiKeyRecord,
  context: { now: Date; environment: ApplicationEnvironment; clientIp?: string | null; serviceAccountStatus: "active" | "suspended" },
): CredentialStatus {
  if (key.revokedAt && key.revokedAt <= context.now) return "revoked";
  if (key.expiresAt && key.expiresAt <= context.now) return "expired";
  if (key.environment !== context.environment) return "wrong_environment";
  if (context.serviceAccountStatus !== "active") return "service_account_suspended";
  if (!ipAllowed(context.clientIp, key.allowedCidrs)) return "network_denied";
  return "active";
}

/** The previous key stays valid for a bounded overlap after rotation. */
export function rotationExpiry(now: Date, overlapHours = 24, currentExpiry?: Date | null): Date {
  if (!Number.isFinite(overlapHours) || overlapHours < 0 || overlapHours > maximumRotationOverlapHours) {
    throw new RangeError(`Rotation overlap must be between 0 and ${maximumRotationOverlapHours} hours`);
  }
  const overlap = new Date(now.getTime() + overlapHours * 3_600_000);
  return currentExpiry && currentExpiry < overlap ? currentExpiry : overlap;
}

/**
 * API-key scopes reuse registered application-plane permission codes and can
 * only reduce the owning service account's application authority.
 */
export function validateApiKeyScopes(registry: PermissionRegistry, scopes: readonly string[], serviceAccountApplicationAuthority: EffectivePermissions): string[] {
  const problems: string[] = [];
  if (scopes.length === 0) problems.push("at least one scope is required");
  if (new Set(scopes).size !== scopes.length) problems.push("scopes must not repeat");
  for (const scope of scopes) {
    const permission = registry.get(scope);
    if (!permission) problems.push(`${scope} is not a registered permission`);
    else if (permission.plane !== "application" || !permission.principals.includes("api_key")) problems.push(`${scope} cannot be granted to API keys`);
    else if (permission.deprecated) problems.push(`${scope} is deprecated`);
    else if (!serviceAccountApplicationAuthority.has(scope)) problems.push(`${scope} exceeds the service account's permissions`);
  }
  return problems;
}
