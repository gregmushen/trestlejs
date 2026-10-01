/**
 * Credential-shape detection for infrastructure documents and provider output.
 * Key names alone are not trusted (spec §24): values are scanned by content.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/u,
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
