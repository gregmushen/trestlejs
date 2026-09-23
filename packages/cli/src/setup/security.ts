import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(left: string | undefined, right: string | undefined): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b) && left.length === right.length;
}

export function secretFingerprint(name: string, value: string): string {
  return createHash("sha256").update(`trestle-fingerprint:v1:${name}:`).update(value).digest("hex").slice(0, 8);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

const secretKeyPattern = /secret|token|password|api[_-]?key/iu;
const credentialValuePattern = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{6,}|\bwhsec_[A-Za-z0-9+/=]{6,}|\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}|\bnapi_[A-Za-z0-9]{8,}|\btr_(?:live|test|dev)_[A-Za-z0-9]{16}_|-----BEGIN [A-Z ]*PRIVATE KEY-----|:\/\/[^\s/:@]+:[^\s/@]+@/u;

export function secretLikeValues(value: unknown, declaredNames: ReadonlySet<string>, trail: Array<string | number> = []): string[] {
  if (typeof value === "string") return credentialValuePattern.test(value) ? [`${trail.join(".") || "plan"}: looks like a credential value; submit secrets through the encrypted credential form`] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => secretLikeValues(item, declaredNames, [...trail, index]));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => {
      const location = [...trail, key];
      if (secretKeyPattern.test(key) && typeof item === "string" && !declaredNames.has(item)) {
        return [`${location.join(".")}: secret-like fields may only reference declared secret names`];
      }
      return secretLikeValues(item, declaredNames, location);
    });
  }
  return [];
}
