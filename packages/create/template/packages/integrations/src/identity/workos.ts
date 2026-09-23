import { IdentityVerificationError, type DirectoryEvent, type DirectoryEventSource, type DirectoryGroupRef, type ExternalIdentity, type SignInRequest, type SsoProvider } from "./types.js";

/**
 * WorkOS over its documented HTTP API (SSO, Organizations, Directory Sync).
 * Only identities and provisioning facts cross this boundary; WorkOS roles
 * and permissions never do.
 */
export type WorkOSConfig = Readonly<{
  apiKey: string;
  clientId: string;
  baseUrl?: string;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}>;

export type WorkOSOrganization = Readonly<{ id: string; name: string; domains: ReadonlyArray<{ domain: string; state: string }> }>;
export type WorkOSDirectory = Readonly<{ id: string; organizationId: string | null; state: string; type: string; name: string }>;
export type WorkOSDirectoryUser = Readonly<{ id: string; directoryId: string; organizationId: string | null; email: string | null; name: string | null; state: string }>;

export class WorkOSError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "WorkOSError";
  }
}

type Json = Record<string, unknown>;
const text = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;

export class WorkOSClient {
  private readonly base: string;
  private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  constructor(private readonly config: WorkOSConfig) {
    this.base = (config.baseUrl ?? "https://api.workos.com").replace(/\/+$/u, "");
    this.fetcher = config.fetcher ?? ((url, init) => fetch(url, init));
  }

  private async request(path: string, init: RequestInit = {}): Promise<Json> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000), headers: { authorization: `Bearer ${this.config.apiKey}`, accept: "application/json", ...(init.headers as Record<string, string> | undefined) } });
    } catch {
      throw new WorkOSError("WorkOS could not be reached", null);
    }
    // Response bodies can echo identifiers; errors carry the status only. Redirects are refused.
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new WorkOSError(`WorkOS responded ${response.status}`, response.status); }
    return await response.json() as Json;
  }

  authorizationUrl(input: Readonly<{ organization: string; redirectUri: string; state: string; loginHint?: string }>): string {
    const url = new URL(`${this.base}/sso/authorize`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", input.state);
    url.searchParams.set("organization", input.organization);
    if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
    return url.toString();
  }

  async profile(code: string): Promise<ExternalIdentity> {
    const body = new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.apiKey, grant_type: "authorization_code", code });
    const result = await this.request("/sso/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    const profile = (result.profile ?? {}) as Json;
    const subject = text(profile.id);
    const email = text(profile.email);
    const connectionId = text(profile.connection_id);
    if (!subject || !email || !connectionId) throw new IdentityVerificationError("WorkOS returned an incomplete profile");
    const name = [text(profile.first_name), text(profile.last_name)].filter(Boolean).join(" ") || null;
    // WorkOS asserts the address from the IdP; Trestle trusts it only for a verified, bound domain.
    return { provider: "workos", connectionId, subject, email: email.toLowerCase(), emailVerified: false, name, organizationId: text(profile.organization_id) };
  }

  async organization(id: string): Promise<WorkOSOrganization> {
    const result = await this.request(`/organizations/${encodeURIComponent(id)}`);
    const domains = Array.isArray(result.domains) ? result.domains as Json[] : [];
    return { id: String(result.id), name: String(result.name ?? ""), domains: domains.map((domain) => ({ domain: String(domain.domain ?? "").toLowerCase(), state: String(domain.state ?? "") })) };
  }

  async directory(id: string): Promise<WorkOSDirectory> {
    const result = await this.request(`/directories/${encodeURIComponent(id)}`);
    return { id: String(result.id), organizationId: text(result.organization_id), state: String(result.state ?? ""), type: String(result.type ?? ""), name: String(result.name ?? "") };
  }

  async directoryUser(id: string): Promise<WorkOSDirectoryUser> {
    const result = await this.request(`/directory_users/${encodeURIComponent(id)}`);
    return directoryUserFrom(result);
  }

  async directoryUserGroups(userId: string): Promise<DirectoryGroupRef[]> {
    const result = await this.request(`/directory_groups?user=${encodeURIComponent(userId)}&limit=100`);
    const data = Array.isArray(result.data) ? result.data as Json[] : [];
    return data.map((group) => ({ externalGroupId: String(group.id), name: String(group.name ?? "") }));
  }
}

function directoryUserFrom(value: Json): WorkOSDirectoryUser {
  const emails = Array.isArray(value.emails) ? value.emails as Json[] : [];
  const primary = text(value.email) ?? text(emails.find((entry) => entry.primary === true)?.value) ?? text(emails[0]?.value);
  const name = [text(value.first_name), text(value.last_name)].filter(Boolean).join(" ") || null;
  return { id: String(value.id), directoryId: String(value.directory_id ?? ""), organizationId: text(value.organization_id), email: primary?.toLowerCase() ?? null, name, state: String(value.state ?? "active") };
}

/** SSO through WorkOS, routed by the Trestle organization's bound WorkOS organization. */
export class WorkOSSsoProvider implements SsoProvider {
  readonly kind = "workos" as const;
  constructor(private readonly client: WorkOSClient, private readonly boundOrganization: (request: SignInRequest) => Promise<string | null>) {}

  async authorizationUrl(request: SignInRequest): Promise<string> {
    const organization = await this.boundOrganization(request);
    if (!organization) throw new IdentityVerificationError("No WorkOS organization is bound for this sign-in");
    return this.client.authorizationUrl({ organization, redirectUri: request.redirectUri, state: request.state });
  }

  async completeSignIn(code: string): Promise<ExternalIdentity> { return await this.client.profile(code); }
}

const encoder = new TextEncoder();
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

/** Signs a body the way WorkOS does; used by tests and the local contract fixture. */
export async function signWorkOSWebhook(secret: string, body: string, timestampMs: number): Promise<string> {
  return `t=${timestampMs}, v1=${await hmacHex(secret, `${timestampMs}.${body}`)}`;
}

/**
 * Verifies `WorkOS-Signature` (HMAC-SHA256 over "<timestamp>.<body>", with a
 * replay window) and normalizes Directory Sync events. Other event types are
 * acknowledged and ignored.
 */
export class WorkOSDirectoryEvents implements DirectoryEventSource {
  readonly kind = "workos" as const;
  constructor(private readonly secret: string, private readonly toleranceMs = 180_000) {}

  async verify(request: Readonly<{ body: string; headers: Readonly<Record<string, string | undefined>> }>, now: Date): Promise<DirectoryEvent[]> {
    const header = request.headers["workos-signature"] ?? "";
    const parts = Object.fromEntries(header.split(",").map((part) => part.trim().split("=", 2) as [string, string]));
    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp) || !parts.v1) throw new IdentityVerificationError("Missing WorkOS signature");
    if (Math.abs(now.getTime() - timestamp) > this.toleranceMs) throw new IdentityVerificationError("WorkOS signature is outside the replay window");
    if (!constantTimeEqual(await hmacHex(this.secret, `${timestamp}.${request.body}`), parts.v1)) throw new IdentityVerificationError("WorkOS signature does not match");
    let event: Json;
    try { event = JSON.parse(request.body) as Json; } catch { throw new IdentityVerificationError("WorkOS event is not JSON"); }
    const type = String(event.event ?? "");
    const data = (event.data ?? {}) as Json;
    const occurredAt = new Date(String(event.created_at ?? now.toISOString()));
    const normalized = (kind: DirectoryEvent["type"], userJson: Json): DirectoryEvent[] => {
      const user = directoryUserFrom(userJson);
      if (!user.email) return [];
      return [{ id: `workos:${String(event.id)}`, type: kind, directoryId: user.directoryId || String(data.directory_id ?? ""), organizationId: null, occurredAt,
        user: { provider: "workos", directoryId: user.directoryId || String(data.directory_id ?? ""), externalId: user.id, email: user.email, name: user.name, active: kind !== "user.deleted" && user.state === "active", groups: [] } }];
    };
    switch (type) {
      case "dsync.user.created":
      case "dsync.user.updated": return normalized(String(data.state ?? "active") === "active" ? "user.upserted" : "user.deactivated", data);
      case "dsync.user.deleted": return normalized("user.deleted", data);
      case "dsync.group.user_added":
      case "dsync.group.user_removed": return normalized("group.membership_changed", { ...(data.user as Json ?? {}), directory_id: data.directory_id });
      default: return [];
    }
  }
}
