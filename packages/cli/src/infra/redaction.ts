/**
 * Credential-shape detection for infrastructure documents and provider output.
 * Key names alone are not trusted (spec §24): values are scanned by content.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Stripe secret, restricted and publishable keys, including newer prefixes such as rkcs_.
  /\b(?:sk|rk|pk|rkcs|sk_org|rk_org)_(?:live|test)_[A-Za-z0-9]{8,}/u,
  /\b[a-z]{2,6}_(?:live|test)_[A-Za-z0-9]{24,}/u,
  /\bwhsec_[A-Za-z0-9+/=]{8,}/u,
  /\bre_[A-Za-z0-9_]{16,}/u,
  /\bnapi_[A-Za-z0-9]{16,}/u,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/u,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:[^\s@"']+@/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
];

export function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

/** Paths of every string leaf in `value` that looks like a credential. */
export function findCredentialLeaves(value: unknown, path = "$"): string[] {
  if (typeof value === "string") return looksLikeCredential(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => findCredentialLeaves(item, `${path}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, member]) => [...(looksLikeCredential(key) ? [`${path}.<key>`] : []), ...findCredentialLeaves(member, `${path}.${key}`)]);
  return [];
}

/** Replaces credential-shaped substrings and any explicitly known secret values. */
export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let result = text;
  for (const secret of knownSecrets) if (secret.length >= 4) result = result.split(secret).join("[redacted]");
  for (const pattern of CREDENTIAL_PATTERNS) result = result.replace(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`), "[redacted]");
  return result;
}

/** Diagnostics must not persist authorization links, credentials, terminal
 * control sequences or unbounded native output in the durable journal. */
function credentialField(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/[- .]/gu, "_").toLowerCase();
  return normalized !== "fencing_token" && (/(?:^|_)(?:password|passwd|secret|token|authorization)(?:_|$)/u.test(normalized) || /(?:^|_)(?:api_key|private_key)(?:_|$)/u.test(normalized) || normalized === "credentials");
}

export function safeInfraDiagnostic(value: unknown): string {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : "detail unavailable";
  const withheld = text.slice(0, 16384)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, "[url withheld]")
    .replace(/(^|\n)([ \t]*(?:set-cookie|cookie)\s*:)[^\r\n]*/giu, "$1$2 [redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+._~\/=\-]+/giu, "$1 [redacted]")
    .replace(/(["']?)([A-Za-z][A-Za-z0-9_.-]*)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gu, (match: string, quote: string, key: string) => credentialField(key) ? `${quote}${key}${quote}=[redacted]` : match);
  return redact(withheld)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 300);
}

export function sanitizedInfraValue(value: unknown): unknown {
  if (typeof value === "string") return safeInfraDiagnostic(value);
  if (Array.isArray(value)) return value.map(sanitizedInfraValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, member]) => [safeInfraDiagnostic(key), credentialField(key) ? "[redacted]" : sanitizedInfraValue(member)]));
  return value;
}
