type SentEmail = { id: string; to: string[]; subject: string; created_at: string };
type RetrievedEmail = SentEmail & { text?: string | null; html?: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sentEmail(value: unknown): value is SentEmail {
  return isRecord(value) && typeof value.id === "string" && Array.isArray(value.to)
    && value.to.every((address) => typeof address === "string")
    && typeof value.subject === "string" && typeof value.created_at === "string";
}

/** Never return or log provider payloads: they can contain verification tokens. */
async function resendJson(url: string, apiKey: string, request: typeof fetch): Promise<unknown> {
  const response = await request(url, { headers: { authorization: `Bearer ${apiKey}` }, cache: "no-store" });
  if (!response.ok) throw new Error(`Staging email inspection failed (HTTP ${response.status})`);
  return await response.json() as unknown;
}

export function verificationLink(message: Pick<RetrievedEmail, "text" | "html">, apiOrigin: string): string | null {
  const content = [message.text, message.html].filter((value): value is string => typeof value === "string").join("\n").replaceAll("&amp;", "&");
  for (const match of content.matchAll(/https?:\/\/[^\s<>"']+/gu)) {
    try {
      const url = new URL(match[0]!.replace(/[).,;]+$/u, ""));
      if (url.origin === apiOrigin && url.pathname === "/api/auth/verify-email" && url.searchParams.has("token")) return url.toString();
    } catch { /* Ignore other links in the email. */ }
  }
  return null;
}

/** Locate only the unique test account's redirected verification email.
 * This requires a staging-only Resend API key with email-list/read permission. */
export async function waitForStagingVerificationLink(input: {
  apiKey: string;
  originalEmail: string;
  apiOrigin: string;
  sentAfter: Date;
  timeoutMs?: number;
  request?: typeof fetch;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
}): Promise<string> {
  if (!input.apiKey || !input.originalEmail || !Number.isFinite(input.sentAfter.getTime())) throw new Error("Staging email inspection is not configured");
  const request = input.request ?? fetch;
  const now = input.now ?? Date.now;
  const pause = input.pause ?? (async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (input.timeoutMs ?? 90_000);
  const subject = `[STAGING → ${input.originalEmail}] Verify your email`;
  do {
    let after: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const url = new URL("https://api.resend.com/emails");
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after", after);
      const listing = await resendJson(url.toString(), input.apiKey, request);
      if (!isRecord(listing) || !Array.isArray(listing.data)) throw new Error("Staging email list response is invalid");
      for (const value of listing.data) {
        if (!sentEmail(value) || value.subject !== subject) continue;
        if (Date.parse(value.created_at) < input.sentAfter.getTime() - 60_000) continue;
        if (value.to.length !== 1 || value.to[0]?.toLowerCase() === input.originalEmail.toLowerCase()) throw new Error("Staging email redirection was not verified");
        const detail = await resendJson(`https://api.resend.com/emails/${encodeURIComponent(value.id)}`, input.apiKey, request);
        if (!sentEmail(detail) || detail.id !== value.id || detail.subject !== subject || detail.to.length !== 1 || detail.to[0] !== value.to[0]) throw new Error("Staging email detail did not match the listing");
        const link = verificationLink(detail as RetrievedEmail, input.apiOrigin);
        if (link) return link;
      }
      const last = listing.data.at(-1);
      if (!listing.has_more || !sentEmail(last) || !listing.data.length || Date.parse(last.created_at) < input.sentAfter.getTime() - 60_000) break;
      after = last.id;
    }
    if (now() >= deadline) break;
    await pause(Math.min(3_000, Math.max(0, deadline - now())));
  } while (now() < deadline);
  throw new Error("Staging verification email was not found before the deadline");
}
