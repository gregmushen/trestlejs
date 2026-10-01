import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted, no whitespace, `undefined` members
 * dropped. Equivalent documents produce identical bytes regardless of source
 * formatting or key order, so digests bind meaning rather than layout.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot encode non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, member]) => member !== undefined).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function canonicalDigest(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}
