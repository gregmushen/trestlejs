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

export type AdminSession = {
  operator: { id: string; email: string };
  roles: string[];
  permissions: string[];
  views: Array<{ id: string; path: string; label: string; group: string; capability: string | null; allowed: boolean }>;
};

export type Overview = { organizations: number; users: number; operators: number; recentAudit: Array<{ name: string; occurredAt: string; actorType: string; organizationId: string | null; outcome: string; correlationId: string }> };

export type CapabilityStatus = { id: string; label: string; state: "configured" | "not_configured" | "unknown"; mode?: string; repair?: string };
export type Health = { environment: string; platformDatabase: { reachable: boolean; distinctLogin: boolean }; application: { reachable: boolean; capabilities: CapabilityStatus[] } };
