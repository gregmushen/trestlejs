import { createAuthClient } from "better-auth/react";

/** The admin API lives on its own origin; in local development Vite proxies it. */
export const adminApiOrigin = (import.meta.env.VITE_ADMIN_API_ORIGIN as string | undefined)?.replace(/\/$/u, "") ?? "";

export const authClient = createAuthClient({ baseURL: adminApiOrigin || window.location.origin });

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly repair?: string) {
    super(message);
    this.name = "AdminApiError";
  }
}

export async function adminApi<T>(path: string): Promise<T> {
  const response = await fetch(`${adminApiOrigin}${path}`, { credentials: "include", headers: { accept: "application/json" } });
  const body = await response.json().catch(() => ({})) as { error?: string; reason?: string; message?: string; repair?: string };
  if (!response.ok) throw new AdminApiError(response.status, body.reason ?? body.error ?? "request_failed", body.message ?? "The request failed", body.repair);
  return body as T;
}

/** Platform actions always carry an operator-entered reason, which is recorded in audit_event. */
export async function adminAction<T>(path: string, reason: string): Promise<T> {
  const response = await fetch(`${adminApiOrigin}${path}`, { method: "POST", credentials: "include", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ reason }) });
  const body = await response.json().catch(() => ({})) as { error?: string; reason?: string; message?: string; repair?: string };
  if (!response.ok) throw new AdminApiError(response.status, body.reason ?? body.error ?? "request_failed", body.message ?? "The action failed", body.repair);
  return body as T;
}

export type AdminSession = {
  operator: { id: string; email: string };
  roles: string[];
  permissions: string[];
  views: Array<{ id: string; path: string; label: string; group: string; capability: string | null; allowed: boolean }>;
};

export type Overview = { organizations: number; users: number; operators: number; recentAudit: Array<{ name: string; occurredAt: string; actorType: string; organizationId: string | null; outcome: string; correlationId: string }> };

export type CapabilityStatus = { id: string; label: string; state: "configured" | "not_configured" | "unknown"; mode?: string; repair?: string };
export type Health = { environment: string; platformDatabase: { reachable: boolean; distinctLogin: boolean }; application: { reachable: boolean; capabilities: CapabilityStatus[] } };

export type DeadOutboxEvent = { id: string; eventName: string; organizationId: string | null; correlationId: string; attempts: number; lastError: string | null; createdAt: string };
export type WebhookOperations = {
  endpoints: Array<{ id: string; organizationId: string; environment: string; name: string; state: string; health: string; provider: string; updatedAt: string }>;
  failedDeliveries: Array<{ id: string; organizationId: string; endpointId: string; eventType: string; state: string; attemptCount: number; terminalReason: string | null; completedAt: string | null; replayable: boolean }>;
};
export type ArtifactOperations = { states: Record<"pending" | "ready" | "cleaning" | "deleted", { count: number; bytes: number }>; stalePending: number };
export type SubscriptionRow = { organizationId: string; organizationName: string; plan: string | null; planVersion: number | null; status: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean | null };
export type CommercialDetail = {
  subscription: { provider: string; plan: string; planVersion: number; status: string; currentPeriodStart: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  planEntitlements: string[];
  overrides: Array<{ entitlement: string; enabled: boolean; reason: string; authorId: string; effectiveAt: string; expiresAt: string | null; removedAt: string | null; removedBy: string | null; removalReason: string | null }>;
  entitlementCatalog: Array<{ code: string; description: string }>;
};

/** A platform action with fields beyond the audited reason. */
export async function adminPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${adminApiOrigin}${path}`, { method: "POST", credentials: "include", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as { error?: string; reason?: string; message?: string; repair?: string };
  if (!response.ok) throw new AdminApiError(response.status, payload.reason ?? payload.error ?? "request_failed", payload.message ?? "The action failed", payload.repair);
  return payload as T;
}
export type PlatformApiKey = { id: string; organizationId: string; serviceAccountId: string; serviceAccountName: string; name: string; environment: string; displayPrefix: string; scopes: string[]; expiresAt: string | null; createdAt: string; rotatedFrom: string | null; revokedAt: string | null; revocationReason: string | null };
export type SupportSessionRecord = { id: string; organizationId: string; operatorId: string; reason: string; startedAt: string; expiresAt: string; endedAt: string | null; endedBy: string | null };
export type SupportOrganization = {
  organization: { id: string; name: string; slug: string | null; createdAt: string } | null;
  members: Array<{ userId: string; role: string; name: string; email: string; joinedAt: string }>;
  subscription: { plan: string; planVersion: number; status: string; currentPeriodEnd: string | null } | null;
  recentAudit: Array<{ name: string; occurredAt: string; actorType: string; outcome: string; correlationId: string }>;
};
