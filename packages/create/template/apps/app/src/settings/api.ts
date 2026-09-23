import { useQuery } from "@tanstack/react-query";

const apiOrigin = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\/$/u, "") ?? "";

export class TenantApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly entitlement?: string, serverMessage?: string) {
    super(code === "entitlement_required" ? `Your plan does not include ${entitlement ?? "this feature"}`
      : code === "forbidden" ? "You do not have permission to do this"
        : code === "tenant_required" ? "Select or create an organization on your dashboard first."
          : code === "unauthorized" ? "Sign in to continue."
            : serverMessage ?? code);
    this.name = "TenantApiError";
  }
}

export async function tenantApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${apiOrigin}${path}`, {
    method: init.method ?? "GET",
    credentials: "include",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({})) as { error?: string; message?: string; entitlement?: string };
  if (!response.ok) throw new TenantApiError(response.status, (payload as { error?: string }).error ?? "request_failed", (payload as { entitlement?: string }).entitlement, (payload as { message?: string }).message);
  return payload as T;
}

export type TenantCapabilityDocument = {
  plan: null | { key: string; name: string; version: string; status: string; renewsAt?: string; cancelAtPeriodEnd: boolean };
  capabilities: Array<{ code: string; name: string; description: string; enabled: boolean; values: Record<string, boolean | number | string | null>; source: "plan" | "contract"; includedWith?: string }>;
  limits: Array<{ code: string; name: string; used: number; included: number; limit: number | null; resetsAt: string; enforcement: "hard" | "soft" }>;
  contractualOverrides: Array<{ code: string; name: string; effectiveAt: string; expiresAt?: string }>;
  scheduledChanges: Array<{ toPlan: string; effectiveAt: string }>;
  upgrades: Array<{ code: string; name: string; availableOn: string[] }>;
  availablePlans: Array<{ key: string; name: string; version: string; current: boolean; capabilities: string[] }>;
};

export type TenantAccess = {
  organizationId: string;
  principal: { id: string; type: string };
  roles: string[];
  permissions: string[];
  capabilities: TenantCapabilityDocument;
};

/** Every tenant query key starts with the organization so switching tenants never reuses cache entries. */
export function useTenantAccess() {
  return useQuery({ queryKey: ["tenant-access"], queryFn: () => tenantApi<TenantAccess>("/api/tenant/access"), retry: false });
}

export const tenantKey = (organizationId: string | undefined, ...parts: string[]) => ["tenant", organizationId ?? "none", ...parts];

export function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}
