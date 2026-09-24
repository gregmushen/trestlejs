import type {
  ActionOutcome, AuditEvent, OrganizationMember, PlatformRoleAssignment, RoleJson, ServiceAccountDetail, UserSummary, AdminSession, ApiKeyMetadata, AuditEventJson, CapabilityStatus, DeadLetter, HealthCheck, OrganizationSummary, Overview, OverviewException,
  SubscriptionDetail, SubscriptionSummary, SupportActivity, SupportPermissionPreview, SupportProfile, SupportSession, SupportSessionSummary, WebhookEndpointDetail, WebhookEndpointSummary,
} from "./api";
import { features } from "./billing-model";

/**
 * Adapts the admin UI's client to the admin Worker's API. The UI keeps its
 * own view models; each method below reads the Worker's responses and maps
 * them, so a view never depends on the Worker's wire format directly. Actions
 * the Worker does not offer are absent here and fail with a clear error.
 */
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Request = <T>(method: Method, path: string, body?: unknown, query?: Record<string, string | undefined>) => Promise<T>;

type WireSession = {
  operator: { id: string; email: string; name?: string };
  roles: string[];
  permissions: string[];
  environment: AdminSession["environment"];
  capabilities: CapabilityStatus[];
  supportSession: { id: string; operatorId: string; organizationId: string; organizationName: string; reason: string; startedAt: string; expiresAt: string } | null;
};
type WireOverview = { organizations: number; users: number; operators: number; recentAudit: Array<{ name: string; occurredAt: string; actorType: string; organizationId: string | null; outcome: string; correlationId: string }> };
type WireHealth = { environment: string; platformDatabase: { reachable: boolean; distinctLogin: boolean }; application: { reachable: boolean } };
type WireOutbox = { counts: Record<"pending" | "leased" | "succeeded" | "dead", number>; dead: Array<{ id: string; eventName: string; organizationId: string | null; correlationId: string; attempts: number; lastError: string | null; createdAt: string }> };
type WireWebhooks = {
  endpoints: Array<{ id: string; organizationId: string; environment: string; name: string; state: string; health: string; provider: string; updatedAt: string }>;
  failedDeliveries: Array<{ id: string; organizationId: string; endpointId: string; eventType: string; state: string; attemptCount: number; terminalReason: string | null; completedAt: string | null; replayable: boolean; replayUnavailableReason: string | null }>;
};
type WireOrganizations = { organizations: Array<{ id: string; name: string; slug: string; createdAt: string; members: number }> };
type WireSupportSessions = { sessions: Array<{ id: string; organizationId: string; operatorId: string; reason: string; startedAt: string; expiresAt: string; endedAt: string | null; endedBy: string | null }>; organizations: Array<{ organizationId: string; organizationName: string }> };
type WireSupportOrganization = { recentAudit: Array<{ name: string; occurredAt: string; actorType: string; outcome: string; correlationId: string }> };
type WireSubscriptions = { subscriptions: Array<{ organizationId: string; organizationName: string; plan: string | null; planVersion: number | null; status: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean | null }> };
type WireCommercial = {
  subscription: { provider: string; plan: string; planVersion: number; status: string; currentPeriodStart: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  planEntitlements: string[];
  overrides: Array<{ entitlement: string; enabled: boolean; reason: string; authorId: string; effectiveAt: string; expiresAt: string | null; removedAt: string | null; removedBy: string | null; removalReason: string | null }>;
};
type WireOrganizationDetail = {
  organization: { id: string; name: string; slug: string; createdAt: string };
  members: Array<{ memberId: string; userId: string; name: string; email: string; organizationRole: string; joinedAt: string }>;
  regional: { language: string | null; locale: string | null; timeZone: string | null; currency: string | null } | null;
};
type WireUsers = { users: Array<{ id: string; name: string; email: string; emailVerified: boolean; createdAt: string; memberships: Array<{ organizationId: string; organizationName: string; organizationRole: string }>; platformRoles: string[] }> };
type WireAuditEvent = { id: string; occurredAt: string; name: string; actorType: string; actorId: string; organizationId: string | null; organizationName: string | null; targetType: string; targetId: string; reason: string | null; outcome: string; environment: string; correlationId: string; supportSessionId: string | null };
type WirePlatformRoles = {
  assignments: Array<{ id: string; userId: string; email: string | null; name: string | null; role: string; grantedAt: string; grantedBy: string; reason: string; revokedAt: string | null; revokedBy: string | null; revocationReason: string | null }>;
  roles: Array<{ key: string; name: string; description: string; permissions: string[] }>;
};
type WireApiKeys = { keys: Array<{ id: string; organizationId: string; serviceAccountId: string; serviceAccountName: string; name: string; environment: string; displayPrefix: string; scopes: string[]; expiresAt: string | null; createdAt: string; rotatedFrom: string | null; revokedAt: string | null; revocationReason: string | null }> };

/** What a read-only support session can see: the organization's profile, members, plan, regional settings, and recent audit. */
const supportProfile: SupportProfile = {
  key: "read_only",
  name: "Read-only support",
  description: "Read the organization's profile, members, plan, regional settings, and recent audit history. No changes, and no tenant-application authority.",
  organization: ["organization.read", "organization.members.read", "organization.billing.read", "organization.regional.read", "organization.audit.read"],
  application: [],
};
const supportPermissions: SupportSession["permissions"] = { organization: supportProfile.organization, application: [], denied: ["every organization write", "every application permission"] };

export class UnsupportedAction extends Error {
  constructor(action: string) {
    super(`${action} is not available in this admin yet`);
    this.name = "UnsupportedAction";
  }
}

const keyStatus = (key: { revokedAt: string | null; expiresAt: string | null }): string => key.revokedAt ? "revoked" : key.expiresAt && Date.parse(key.expiresAt) <= Date.now() ? "expired" : "active";

export function mainBackend(request: Request, reasoned: (reason: string) => { reason: string }) {
  const session = async (): Promise<AdminSession> => {
    const wire = await request<WireSession>("GET", "session");
    return {
      operator: { id: wire.operator.id, email: wire.operator.email, name: wire.operator.name ?? wire.operator.email },
      roles: wire.roles,
      permissions: wire.permissions,
      environment: wire.environment,
      // The Worker does not require step-up yet; the UI treats every session as fresh.
      stepUpRequiredAfter: new Date(Date.now() + 15 * 60_000).toISOString(),
      assurance: null,
      supportSession: wire.supportSession ? { ...wire.supportSession, ticket: null, profile: supportProfile.name, permissions: supportPermissions, endedAt: null, endReason: null, endedBy: null, revocationReason: null } : null,
    };
  };
  const capabilities = async () => ({ capabilities: (await request<WireSession>("GET", "session")).capabilities });
  const organizations = async (q?: string): Promise<{ organizations: OrganizationSummary[] }> => {
    const wire = await request<WireOrganizations>("GET", "organizations", undefined, { q });
    return { organizations: wire.organizations.map((item) => ({ id: item.id, name: item.name, slug: item.slug, createdAt: item.createdAt, members: item.members })) };
  };
  const organizationNames = async (): Promise<Map<string, string>> => {
    const list = await organizations().catch(() => ({ organizations: [] }));
    return new Map(list.organizations.map((item) => [item.id, item.name]));
  };
  const webhookState = async () => await request<WireWebhooks>("GET", "operations/webhooks");
  const webhooks = async (filter: { organizationId?: string; state?: string; q?: string }): Promise<{ endpoints: WebhookEndpointSummary[] }> => {
    const [wire, names] = await Promise.all([webhookState(), organizationNames()]);
    const q = filter.q?.toLowerCase();
    const endpoints = wire.endpoints
      .filter((endpoint) => (!filter.organizationId || endpoint.organizationId === filter.organizationId) && (!filter.state || endpoint.state === filter.state))
      .map((endpoint): WebhookEndpointSummary => {
        const failures = wire.failedDeliveries.filter((delivery) => delivery.endpointId === endpoint.id);
        return {
          id: endpoint.id, organizationId: endpoint.organizationId, organizationName: names.get(endpoint.organizationId) ?? endpoint.organizationId, name: endpoint.name,
          url: `${endpoint.provider} destination`, events: [], state: endpoint.state as WebhookEndpointSummary["state"], health: endpoint.health,
          disabledReason: null, disabledBy: null, consecutiveFailures: 0, secretFingerprint: "", verifiedAt: null, lastSuccessAt: null,
          lastFailureAt: failures.map((delivery) => delivery.completedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
          createdAt: endpoint.updatedAt, failed24h: failures.length, pending: 0,
        };
      })
      .filter((endpoint) => !q || `${endpoint.name} ${endpoint.organizationName}`.toLowerCase().includes(q));
    return { endpoints };
  };
  const webhook = async (id: string) => {
    const wire = await webhookState();
    const endpoint = wire.endpoints.find((item) => item.id === id);
    if (!endpoint) throw new Error("Webhook endpoint not found");
    const detail: WebhookEndpointDetail = {
      id: endpoint.id, organizationId: endpoint.organizationId, name: endpoint.name, description: null, urlDisplay: `${endpoint.provider} destination (hidden from platform operators)`, events: [],
      state: endpoint.state, health: endpoint.health, timeoutMs: 0, disabledReason: null, consecutiveFailures: 0, secret: { fingerprint: "hidden", createdAt: endpoint.updatedAt, previousExpiresAt: null },
      lastSuccessAt: null, lastFailureAt: null, verifiedAt: null, createdAt: endpoint.updatedAt,
    };
    const deliveries = wire.failedDeliveries.filter((delivery) => delivery.endpointId === id).map((delivery) => ({
      id: delivery.id, organizationId: delivery.organizationId, eventId: delivery.id, event: delivery.eventType, version: 1, status: delivery.state, attempts: delivery.attemptCount,
      responseCode: null, failureCategory: delivery.terminalReason, correlationId: "", test: false, replayOf: null, createdAt: delivery.completedAt ?? endpoint.updatedAt, completedAt: delivery.completedAt,
      nextAttemptAt: null, replayable: delivery.replayable, replayUnavailableReason: delivery.replayUnavailableReason,
    }));
    return { endpoint: detail, deliveries, attempts: {} as Record<string, never[]> };
  };
  const findEndpoint = async (id: string) => (await webhookState()).endpoints.find((item) => item.id === id);
  const findDelivery = async (id: string) => (await webhookState()).failedDeliveries.find((item) => item.id === id);
  const apiKeyList = async (organizationId?: string): Promise<ApiKeyMetadata[]> => {
    const [wire, names] = await Promise.all([request<WireApiKeys>("GET", "security/api-keys"), organizationNames()]);
    return wire.keys.filter((key) => !organizationId || key.organizationId === organizationId).map((key) => ({
      id: key.id, organizationId: key.organizationId, organizationName: names.get(key.organizationId) ?? key.organizationId, serviceAccountId: key.serviceAccountId, serviceAccountName: key.serviceAccountName,
      name: key.name, displayPrefix: key.displayPrefix, environment: key.environment as ApiKeyMetadata["environment"], scopes: key.scopes, status: keyStatus(key), createdAt: key.createdAt,
      expiresAt: key.expiresAt, revokedAt: key.revokedAt, rotatedFrom: key.rotatedFrom, revocationReason: key.revocationReason, lastUsedAt: null,
    }));
  };
  const supportList = async (): Promise<SupportSessionSummary[]> => {
    const [wire, current] = await Promise.all([request<WireSupportSessions>("GET", "support/sessions"), session()]);
    const names = new Map(wire.organizations.map((item) => [item.organizationId, item.organizationName]));
    return wire.sessions.map((item) => ({
      ...item, organizationName: names.get(item.organizationId) ?? item.organizationId, ticket: null, profile: supportProfile.name, permissions: supportPermissions,
      endReason: item.endedAt ? (item.endedBy === "system:support-expiry" ? "expired" : "ended") : null, revocationReason: null,
      operator: current.operator, activity: 0,
    }));
  };

  const subscriptionRows = async (q?: string): Promise<SubscriptionSummary[]> => {
    const wire = await request<WireSubscriptions>("GET", "commercial/subscriptions");
    const query = q?.trim().toLowerCase();
    return wire.subscriptions
      .map((row): SubscriptionSummary => ({
        organizationId: row.organizationId, organizationName: row.organizationName, plan: row.plan ?? "none", status: row.status ?? "none", provider: "—",
        ...(row.planVersion !== null && row.plan ? { planVersion: `${row.plan}@${row.planVersion}` } : {}),
        ...(row.currentPeriodEnd ? { currentPeriodEnd: row.currentPeriodEnd } : {}), ...(row.cancelAtPeriodEnd !== null ? { cancelAtPeriodEnd: row.cancelAtPeriodEnd } : {}),
      }))
      .filter((row) => !query || `${row.organizationName ?? ""} ${row.organizationId} ${row.plan}`.toLowerCase().includes(query));
  };

  const auditEvent = (event: WireAuditEvent): AuditEvent => ({
    id: event.id, name: event.name, occurredAt: event.occurredAt, actor: event.actorId, actorType: event.actorType, organizationId: event.organizationId,
    ...(event.organizationName ? { organizationName: event.organizationName } : {}), target: `${event.targetType}:${event.targetId}`, ...(event.reason ? { reason: event.reason } : {}),
    outcome: event.outcome, correlationId: event.correlationId, environment: event.environment, ...(event.supportSessionId ? { supportSessionId: event.supportSessionId } : {}),
  });
  const platformRoleState = async (history: boolean) => await request<WirePlatformRoles>("GET", "platform-roles", undefined, { history: history ? "1" : undefined });

  return {
    session,
    capabilities,
    organization: async (id: string): Promise<{ organization: OrganizationSummary & { regional?: WireOrganizationDetail["regional"] }; members: OrganizationMember[] }> => {
      const wire = await request<WireOrganizationDetail>("GET", `organizations/${encodeURIComponent(id)}`);
      return {
        organization: { ...wire.organization, members: wire.members.length, regional: wire.regional },
        // Application roles are tenant data outside the platform role's grants; organization roles are shown.
        members: wire.members.map((entry) => ({ memberId: entry.memberId, userId: entry.userId, email: entry.email, name: entry.name, organizationRoles: [entry.organizationRole], applicationRoles: [] })),
      };
    },
    users: async (q?: string): Promise<{ users: UserSummary[] }> => {
      const wire = await request<WireUsers>("GET", "users", undefined, { q });
      return { users: wire.users.map((entry) => ({ id: entry.id, email: entry.email, name: entry.name, emailVerified: entry.emailVerified, banned: false, createdAt: entry.createdAt, platformRoles: entry.platformRoles, memberships: entry.memberships.map((membership) => ({ organizationId: membership.organizationId, organizationName: membership.organizationName, organizationRoles: [membership.organizationRole], applicationRoles: [] })) })) };
    },
    audit: async (filters: { organizationId?: string; actor?: string; name?: string; correlation?: string; page?: string; pageSize?: string }) => {
      const wire = await request<{ events: WireAuditEvent[]; total: number; page: number; pageSize: number }>("GET", "audit", undefined, filters);
      return { ...wire, events: wire.events.map(auditEvent) };
    },
    auditEvent: async (id: string) => ({ event: auditEvent((await request<{ event: WireAuditEvent }>("GET", `audit/${encodeURIComponent(id)}`)).event) }),
    roles: async (): Promise<{ organization: RoleJson[]; application: RoleJson[]; platform: RoleJson[] }> => ({
      organization: [], application: [],
      platform: (await platformRoleState(false)).roles.map((role) => ({ key: role.key, name: role.name, description: role.description, plane: "platform" as const, permissions: role.permissions, custom: false })),
    }),
    platformRoles: async (includeRevoked = false): Promise<{ assignments: PlatformRoleAssignment[] }> => ({
      assignments: (await platformRoleState(includeRevoked)).assignments.map((entry) => ({ id: entry.id, userId: entry.userId, ...(entry.email ? { email: entry.email } : {}), ...(entry.name ? { name: entry.name } : {}), role: entry.role, grantedAt: entry.grantedAt, grantedBy: entry.grantedBy, reason: entry.reason, revokedAt: entry.revokedAt, revokedBy: entry.revokedBy })),
    }),
    assignPlatformRole: async (userId: string, role: string, reason: string): Promise<ActionOutcome> => {
      await request("POST", "platform-roles", { userId, role, ...reasoned(reason) });
      return { succeeded: [role] };
    },
    revokePlatformRole: async (userId: string, role: string, reason: string): Promise<ActionOutcome> => {
      await request("POST", `platform-roles/${encodeURIComponent(userId)}/${encodeURIComponent(role)}/revoke`, reasoned(reason));
      return { succeeded: [role] };
    },
    features: async () => ({ features: [...features.list()] }),
    subscriptions: async (q?: string) => ({ subscriptions: await subscriptionRows(q) }),
    subscription: async (organizationId: string): Promise<SubscriptionDetail> => {
      const [wire, rows] = await Promise.all([request<WireCommercial>("GET", `commercial/subscriptions/${encodeURIComponent(organizationId)}`), subscriptionRows()]);
      const summary = rows.find((row) => row.organizationId === organizationId);
      return {
        subscription: wire.subscription ? { organizationId, ...(summary?.organizationName ? { organizationName: summary.organizationName } : {}), plan: wire.subscription.plan, planVersion: `${wire.subscription.plan}@${wire.subscription.planVersion}`, status: wire.subscription.status, provider: wire.subscription.provider, ...(wire.subscription.currentPeriodEnd ? { currentPeriodEnd: wire.subscription.currentPeriodEnd } : {}), cancelAtPeriodEnd: wire.subscription.cancelAtPeriodEnd } : null,
        planVersion: null,
        // Overrides are keyed by entitlement: a new one supersedes the active one, and revoking restores the plan.
        overrides: wire.overrides.map((override) => ({ id: `${override.entitlement}@${override.effectiveAt}`, organizationId, code: override.entitlement, enabled: override.enabled, values: {}, reason: override.reason, author: override.authorId, effectiveAt: override.effectiveAt, expiresAt: override.expiresAt, removedAt: override.removedAt })),
        scheduledChanges: [],
        reconciliations: [],
        effective: wire.planEntitlements.map((code) => ({ code, enabled: true, source: "plan" as const, effectiveAt: new Date().toISOString() })),
      };
    },
    addOverride: async (organizationId: string, input: { code: string; enabled: boolean; expiresAt?: string }, reason: string) => {
      await request("POST", `commercial/subscriptions/${encodeURIComponent(organizationId)}/overrides`, { entitlement: input.code, enabled: input.enabled, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}), ...reasoned(reason) });
      return { succeeded: [input.code] } as ActionOutcome;
    },
    removeOverride: async (organizationId: string, id: string, reason: string): Promise<ActionOutcome> => {
      const entitlement = id.split("@")[0]!;
      await request("POST", `commercial/subscriptions/${encodeURIComponent(organizationId)}/overrides/${encodeURIComponent(entitlement)}/revoke`, reasoned(reason));
      return { succeeded: [entitlement] };
    },
    organizations,
    overview: async (): Promise<Overview> => {
      const [wire, caps] = await Promise.all([request<WireOverview>("GET", "overview"), capabilities()]);
      const [outbox, hooks] = await Promise.all([request<WireOutbox>("GET", "operations/outbox").catch(() => null), webhookState().catch(() => null)]);
      const exceptions: OverviewException[] = [];
      if (outbox?.counts.dead) exceptions.push({ kind: "dead-letters", severity: "critical", title: `${outbox.counts.dead} dead-lettered event${outbox.counts.dead === 1 ? "" : "s"}`, detail: "Events stopped retrying and need review or redrive.", href: "/operations/async", count: outbox.counts.dead });
      if (hooks?.failedDeliveries.length) exceptions.push({ kind: "webhook-failures", severity: "warning", title: `${hooks.failedDeliveries.length} failed webhook deliver${hooks.failedDeliveries.length === 1 ? "y" : "ies"}`, detail: "Dead or exhausted deliveries; replay those whose payload is still retained.", href: "/integrations/webhooks", count: hooks.failedDeliveries.length });
      for (const status of caps.capabilities.filter((item) => item.state === "declared")) exceptions.push({ kind: `capability:${status.id}`, severity: "warning", title: `${status.label} is not configured`, detail: status.repair ? `Run ${status.repair}` : "Configure it with trestle setup.", href: "/system/health" });
      const mode = (id: string) => { const status = caps.capabilities.find((item) => item.id === id); return status ? { mode: status.mode ?? status.state, healthy: status.healthy } : "unknown"; };
      return { environment: (await session()).environment, capabilities: caps.capabilities, providers: { email: mode("email"), payments: mode("payments") }, migrations: { applied: -1 }, counts: { organizations: wire.organizations, users: wire.users, deadLetters: outbox?.counts.dead ?? 0 }, exceptions };
    },
    health: async (): Promise<{ checks: HealthCheck[] }> => {
      const wire = await request<WireHealth>("GET", "health");
      return { checks: [
        { name: "Platform database", status: wire.platformDatabase.reachable ? "ok" : "failed", detail: wire.platformDatabase.reachable ? "Reachable as the trestle_platform login" : "Unreachable" },
        { name: "Distinct platform login", status: wire.platformDatabase.distinctLogin ? "ok" : wire.environment === "local" ? "degraded" : "failed", detail: wire.platformDatabase.distinctLogin ? "DATABASE_ADMIN_URL is set" : "Using the application login (allowed only locally)" },
        { name: "Customer application", status: wire.application.reachable ? "ok" : "failed", detail: wire.application.reachable ? "Operational status is readable" : "Operational status could not be read" },
      ] };
    },
    async: async () => {
      const wire = await request<WireOutbox>("GET", "operations/outbox");
      const dead: DeadLetter[] = wire.dead.map((event) => ({ id: event.id, event: event.eventName, attempts: event.attempts, lastErrorCategory: event.lastError ?? "unknown", availableAt: event.createdAt }));
      return { outbox: wire.counts, dead };
    },
    redrive: async (id: string, reason: string): Promise<ActionOutcome> => {
      await request("POST", `operations/outbox/${encodeURIComponent(id)}/redrive`, reasoned(reason));
      return { succeeded: [id] };
    },
    artifactTotals: async () => await request<{ states: Record<"pending" | "ready" | "cleaning" | "deleted", { count: number; bytes: number }>; stalePending: number }>("GET", "operations/artifacts"),
    webhooks,
    webhook,
    disableWebhook: async (id: string, reason: string): Promise<ActionOutcome> => {
      const endpoint = await findEndpoint(id);
      if (!endpoint) throw new Error("Webhook endpoint not found");
      await request("POST", `operations/webhooks/${encodeURIComponent(endpoint.organizationId)}/endpoints/${encodeURIComponent(id)}/disable`, reasoned(reason));
      return { succeeded: [id] };
    },
    replayWebhookDelivery: async (id: string, reason: string): Promise<ActionOutcome> => {
      const delivery = await findDelivery(id);
      if (!delivery) throw new Error("Webhook delivery not found");
      await request("POST", `operations/webhooks/${encodeURIComponent(delivery.organizationId)}/deliveries/${encodeURIComponent(id)}/replay`, reasoned(reason));
      return { succeeded: [id] };
    },
    apiKeys: async (organizationId?: string) => ({ apiKeys: await apiKeyList(organizationId) }),
    apiKey: async (id: string) => {
      const key = (await apiKeyList()).find((item) => item.id === id);
      if (!key) throw new Error("API key not found");
      return { key, lineage: [] as ApiKeyMetadata[], usage: [] as Array<{ day: string; requests: number; denied: number }>, audit: [] as AuditEventJson[], serviceAccount: null as ServiceAccountDetail["account"] | null };
    },
    revokeApiKey: async (id: string, reason: string): Promise<ActionOutcome> => {
      const key = (await apiKeyList()).find((item) => item.id === id);
      if (!key) throw new Error("API key not found");
      await request("POST", `security/api-keys/${encodeURIComponent(key.organizationId)}/${encodeURIComponent(id)}/revoke`, reasoned(reason));
      return { succeeded: [id] };
    },
    supportProfiles: async () => ({ profiles: [supportProfile], durations: [15, 30, 60, 120, 240] }),
    previewSupport: async (_organizationId: string, _profile: string): Promise<{ profile: SupportProfile; permissions: SupportPermissionPreview[] }> => ({
      profile: supportProfile,
      permissions: [
        ...supportProfile.organization.map((code): SupportPermissionPreview => ({ code, plane: "organization", description: code, allowed: true, reason: "granted by the read-only support profile" })),
        { code: "organization writes", plane: "organization", description: "Any change to the organization", allowed: false, reason: "support sessions are read-only" },
        { code: "application permissions", plane: "application", description: "Product actions", allowed: false, reason: "support sessions grant no tenant-application authority" },
      ],
    }),
    startSupportSession: async (input: { organizationId: string; profile: string; durationMinutes: number; ticket?: string }, reason: string): Promise<{ session: SupportSession }> => {
      const started = await request<{ id: string; organizationId: string; expiresAt: string }>("POST", "support/sessions", { organizationId: input.organizationId, durationMinutes: input.durationMinutes, ...reasoned(reason) });
      const current = await session();
      return { session: current.supportSession ?? { id: started.id, operatorId: current.operator.id, organizationId: started.organizationId, organizationName: started.organizationId, reason, ticket: null, profile: supportProfile.name, permissions: supportPermissions, startedAt: new Date().toISOString(), expiresAt: started.expiresAt, endedAt: null, endReason: null, endedBy: null, revocationReason: null } };
    },
    exitSupportSession: async (): Promise<void> => {
      const current = await session();
      if (current.supportSession) await request("POST", `support/sessions/${encodeURIComponent(current.supportSession.id)}/end`, { reason: "Operator exited the support session" });
    },
    supportSessions: async (status?: "active") => {
      const sessions = await supportList();
      return { sessions: status === "active" ? sessions.filter((item) => !item.endedAt && Date.parse(item.expiresAt) > Date.now()) : sessions };
    },
    supportSession: async (id: string): Promise<{ session: SupportSession & { operator: SupportSessionSummary["operator"] }; activity: SupportActivity[] }> => {
      const found = (await supportList()).find((item) => item.id === id);
      if (!found) throw new Error("Support session not found");
      const open = !found.endedAt && Date.parse(found.expiresAt) > Date.now();
      const view = open ? await request<WireSupportOrganization>("GET", `support/sessions/${encodeURIComponent(id)}/organization`).catch(() => null) : null;
      const activity = (view?.recentAudit ?? []).map((event, index): SupportActivity => ({ id: `${event.correlationId}:${index}`, name: event.name, occurredAt: event.occurredAt, actor: event.actorType, target: found.organizationName, outcome: event.outcome, correlationId: event.correlationId }));
      return { session: found, activity };
    },
  };
}
