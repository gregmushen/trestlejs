import { useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { adminQueryKey, api, sessionQueryKey, type AdminSession, type CapabilityStatus, type QueryScope, type SupportSession, type TenantContext } from "../api";
import { visibleNavigation, type AdminRegistry, type CapabilityId, type Environment, type NavigationContext } from "../registry";

export type AdminContextValue = Readonly<{
  session: AdminSession;
  environment: Environment;
  permissions: ReadonlySet<string>;
  can: (permission: string) => boolean;
  /** The active support session, if any. Tenant-bound views follow its tenant. */
  supportSession: SupportSession | null;
  tenantContext: TenantContext | null;
  startSupportSession: (input: { organizationId: string; targetUserId?: string; profile: string; durationMinutes: number; ticket?: string }, reason: string) => Promise<SupportSession>;
  exitSupportSession: () => Promise<void>;
  capabilities: readonly CapabilityStatus[];
  capability: (id: CapabilityId) => CapabilityStatus | undefined;
  navigationContext: NavigationContext;
  navigation: ReturnType<typeof visibleNavigation>;
  registry: AdminRegistry;
  scope: QueryScope;
}>;

const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if (!value) throw new Error("useAdmin must be used inside <AdminProvider>");
  return value;
}

/** Re-renders every second; used for expiration countdowns. */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), intervalMs); return () => window.clearInterval(timer); }, [intervalMs]);
  return now;
}

export function AdminProvider(props: { session: AdminSession; registry: AdminRegistry; children: ReactNode }) {
  const { session, registry } = props;
  const queryClient = useQueryClient();
  const environment = session.environment;
  const [expired, setExpired] = useState<string | null>(null);
  const reported = session.supportSession ?? null;
  const supportSession = reported && reported.id !== expired && Date.parse(reported.expiresAt) > Date.now() ? reported : null;
  const tenantContext = useMemo<TenantContext | null>(() => supportSession ? { organizationId: supportSession.organizationId, name: supportSession.organizationName, enteredAt: supportSession.startedAt, expiresAt: supportSession.expiresAt } : null, [supportSession]);
  const permissions = useMemo(() => new Set(session.permissions), [session.permissions]);
  const capabilitiesQuery = useQuery({ queryKey: ["admin", environment, "capabilities"], queryFn: api.capabilities, staleTime: 60_000 });
  const capabilities = useMemo(() => capabilitiesQuery.data?.capabilities ?? [], [capabilitiesQuery.data]);
  const navigationContext = useMemo<NavigationContext>(() => ({
    permissions,
    environment,
    capabilityStates: Object.fromEntries(capabilities.map((status) => [status.id, status])),
  }), [capabilities, environment, permissions]);

  // Authority ends at the deadline: stop using the session locally, then let the server confirm.
  useEffect(() => {
    if (!supportSession) return;
    const timer = window.setTimeout(() => { setExpired(supportSession.id); void queryClient.invalidateQueries({ queryKey: sessionQueryKey }); }, Math.max(0, Date.parse(supportSession.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [queryClient, supportSession]);

  // Leaving a tenant (exit, expiry, revocation, or switching) drops everything cached for it.
  const previousTenant = useRef<string | null>(tenantContext?.organizationId ?? null);
  useEffect(() => {
    const previous = previousTenant.current;
    previousTenant.current = tenantContext?.organizationId ?? null;
    if (previous && previous !== tenantContext?.organizationId) {
      queryClient.removeQueries({ queryKey: ["admin", environment, previous] });
      queryClient.removeQueries({ queryKey: ["admin", environment, "support"] });
    }
  }, [environment, queryClient, tenantContext?.organizationId]);

  const startSupportSession = useCallback(async (input: { organizationId: string; targetUserId?: string; profile: string; durationMinutes: number; ticket?: string }, reason: string) => {
    const { session: started } = await api.startSupportSession(input, reason);
    await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    return started;
  }, [queryClient]);
  const exitSupportSession = useCallback(async () => {
    await api.exitSupportSession();
    await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    await queryClient.invalidateQueries({ queryKey: ["admin", environment] });
  }, [environment, queryClient]);

  const value = useMemo<AdminContextValue>(() => ({
    session,
    environment,
    permissions,
    can: (permission) => permissions.has(permission),
    supportSession,
    tenantContext,
    startSupportSession,
    exitSupportSession,
    capabilities,
    capability: (id) => capabilities.find((status) => status.id === id),
    navigationContext,
    navigation: visibleNavigation(registry, navigationContext),
    registry,
    scope: { environment, tenantContextId: tenantContext?.organizationId ?? null },
  }), [capabilities, environment, exitSupportSession, navigationContext, permissions, registry, session, startSupportSession, supportSession, tenantContext]);

  return <AdminContext.Provider value={value}>{props.children}</AdminContext.Provider>;
}

/** Queries keyed by environment and tenant context so cached data never crosses either boundary. */
export function useAdminQuery<T>(parts: readonly unknown[], queryFn: () => Promise<T>, options: Omit<UseQueryOptions<T>, "queryKey" | "queryFn"> = {}) {
  const { scope } = useAdmin();
  return useQuery<T>({ queryKey: adminQueryKey(scope, ...parts), queryFn, ...options });
}

export function useInvalidate() {
  const queryClient = useQueryClient();
  const { scope } = useAdmin();
  return useCallback((...parts: readonly unknown[]) => queryClient.invalidateQueries({ queryKey: adminQueryKey(scope, ...parts) }), [queryClient, scope]);
}

/**
 * Organization filter for tenant-bound views. It defaults to the active tenant
 * context and follows it when the operator enters or exits a context.
 */
export function useTenantScope(): [string, (organizationId: string) => void] {
  const { tenantContext } = useAdmin();
  const [organizationId, setOrganizationId] = useState(tenantContext?.organizationId ?? "");
  useEffect(() => { setOrganizationId(tenantContext?.organizationId ?? ""); }, [tenantContext?.organizationId]);
  return [organizationId, setOrganizationId];
}
