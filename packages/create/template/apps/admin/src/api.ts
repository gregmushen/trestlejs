import type { AccessDecision } from "@__TRESTLE_PROJECT_NAME__/authz";
import type { EffectiveEntitlement, Feature, PlanVersion, PlanVersionState, PrivilegeValue, QuotaState, ReconciliationResult } from "@__TRESTLE_PROJECT_NAME__/billing";
import { z } from "zod";

import type { CapabilityId, CapabilityState, Environment } from "./registry";

/* Platform admin API types (served by apps/admin/worker under /api/admin). Dates arrive as ISO strings. */

type Jsonify<T> = T extends Date ? string : T extends readonly (infer Item)[] ? Jsonify<Item>[] : T extends object ? { [Key in keyof T]: Jsonify<T[Key]> } : T;

/** Cross-tenant enterprise identity status; never secrets, IdP configuration, or provisioned emails. */
export type IdentityStatus = {
  connections: Array<{ organizationId: string; organizationName: string | null; provider: string; kind: string; externalId: string; domain: string | null; state: string; lastEventAt: string | null; lastError: string | null; mappings: number; createdAt: string }>;
  ssoProviders: Array<{ providerId: string; organizationId: string | null; organizationName: string | null; issuer: string; domain: string; domainVerified: boolean }>;
  scim: Array<{ connectionId: string; organizationId: string; organizationName: string | null; status: string; activeUsers: number; createdAt: string; credential: { credentialId: string; expiresAt: string | null; lastUsedAt: string | null } | null }>;
  events: Array<{ id: string; organizationId: string; organizationName: string | null; provider: string; type: string; outcome: string; receivedAt: string }>;
};

/** Local usage versus the metering provider's accepted and reported figures. */
export type FeatureExplanation = { code: string; name: string; description: string; metered: boolean; status: "included" | "overridden" | "removed" | "unavailable"; values: Record<string, PrivilegeValue>; provenance: Array<{ name: string; value: PrivilegeValue; source: "plan" | "override"; ref: string | null }>; unset: string[]; overrideId?: string; effectiveAt?: string; expiresAt?: string };
export type EntitlementChange = { code: string; name: string; change: "added" | "removed" | "changed" | "unchanged"; before: { enabled: boolean; values: Record<string, PrivilegeValue> } | null; after: { enabled: boolean; values: Record<string, PrivilegeValue> } | null; differences: Array<{ name: string; before?: PrivilegeValue; after?: PrivilegeValue }> };
export type EntitlementExplorer = {
  effective: EffectiveEntitlement[]; quotas: QuotaState[]; metering: UsageProvenanceRow[];
  subscription: (SubscriptionSummary & { planName: string | null }) | null;
  features: FeatureExplanation[];
  overrides: Array<{ id: string; code: string; enabled: boolean; values: Record<string, PrivilegeValue>; reason: string; author: string; effectiveAt: string; expiresAt: string | null; scheduled: boolean }>;
  scheduledChanges: ScheduledChange[];
};
export type AuthPolicy = {
  signIn: { password: boolean };
  registration: { mode: "open" | "invite_only" | "closed"; requireEmailVerification: boolean };
  password: { minLength: number; resetEnabled: boolean; revokeSessionsOnReset: boolean };
  mfa: { trustedDeviceDays: number };
  stepUp: { windowMinutes: number };
  sessions: { lifetimeDays: number; refreshHours: number; maxConcurrent: number };
  organizations: { allowCreation: boolean; limitPerUser: number; invitationExpiryDays: number; membershipLimit: number };
};
export type AuthPolicyVersion = { version: number; state: "draft" | "active" | "superseded" | "discarded"; policy: AuthPolicy; basedOn: number | null; createdBy: string; createdAt: string; activatedBy: string | null; activatedAt: string | null; reason: string | null; impact: string[] };
export type AuthPolicyState = {
  environment: string;
  effective: { policy: AuthPolicy; version: number | null; sources: Record<string, string>; problems: string[] };
  setup: Array<{ label: string; value: string; source: string; healthy: boolean | null }>;
  email: { mode: string; healthy: boolean; message: string | null; flows: string[] };
  guardians: { roles: string[]; total: number; withPasskey: number; withTwoFactor: number };
  draft: { version: number; basedOn: number | null; policy: AuthPolicy; createdBy: string; createdAt: string; shape: string[]; safeguards: string[]; impact: string[] } | null;
  versions: AuthPolicyVersion[];
  defaults: AuthPolicy;
};
export type UsageProvenanceRow = { featureCode: string; periodStart: string; periodEnd: string; local: number; reported: number; provider: string | null; providerObservedAt: string | null; providerBalance: number | null; providerHasAccess: boolean | null; drift: { difference: number; outcome: "in_sync" | "provider_behind" | "provider_ahead" } | null };

export type Operator = { id: string; email: string; name: string };
/** An operator's audited, time-boxed support session in one tenant. */
export type SupportSession = {
  id: string; operatorId: string; organizationId: string; organizationName: string; reason: string; ticket: string | null; profile: string;
  permissions: { organization: string[]; application: string[]; denied: string[] };
  startedAt: string; expiresAt: string; endedAt: string | null; endReason: string | null; endedBy: string | null; revocationReason: string | null;
};
/** The tenant scope every tenant-bound view follows; derived from the active support session. */
export type TenantContext = { organizationId: string; name: string; enteredAt: string; expiresAt: string };
export type AdminSession = {
  operator: Operator;
  roles: string[];
  permissions: string[];
  environment: Environment;
  stepUpRequiredAfter: string;
  supportSession?: SupportSession | null;
  /** How this session was authenticated; sensitive actions require a level and freshness from it. */
  assurance?: { level: "password" | "mfa" | "phishing_resistant"; method: string; verifiedAt: string } | null;
};
export type SupportProfile = { key: string; name: string; description: string; organization: string[]; application: string[] };
export type SupportPermissionPreview = { code: string; plane: "organization" | "application"; description: string; allowed: boolean; reason: string };
export type SupportSessionSummary = SupportSession & { operator: Operator; activity: number };
export type SupportActivity = { id: string; name: string; occurredAt: string; actor: string; target: string; reason?: string; outcome: string; correlationId: string };
export type WebhookEndpointSummary = {
  id: string; organizationId: string; organizationName: string; name: string; url: string; events: string[]; state: "active" | "paused" | "disabled";
  disabledReason: string | null; disabledBy: string | null; consecutiveFailures: number; secretFingerprint: string; verifiedAt: string | null; lastSuccessAt: string | null; lastFailureAt: string | null; createdAt: string; failed24h: number; pending: number;
};
export type WebhookEndpointDetail = {
  id: string; organizationId: string; name: string; description: string | null; urlDisplay: string; events: string[]; state: string; health: string; timeoutMs: number; disabledReason: string | null; consecutiveFailures: number;
  secret: { fingerprint: string; createdAt: string; previousExpiresAt: string | null }; lastSuccessAt: string | null; lastFailureAt: string | null; verifiedAt: string | null; createdAt: string; deletedAt?: string | null;
};
export type WebhookAttemptJson = { attemptedAt: string; responseCode: number | null; failureCategory: string | null; durationMs: number };
export type WebhookDeliveryJson = {
  id: string; organizationId: string; eventId: string; event: string; version: number; status: string; attempts: number; responseCode: number | null; failureCategory: string | null;
  correlationId: string; test: boolean; replayOf: string | null; createdAt: string; completedAt: string | null; nextAttemptAt: string | null; history: WebhookAttemptJson[];
};
export type NotificationChannelState = { id: string; channel: string; status: string; failureCategory: string | null; attempts: number };
export type NotificationSummary = {
  id: string; organizationId: string; organizationName: string; recipient: { userId: string; name: string; email: string }; type: string; groupCount: number;
  correlationId: string; createdAt: string; updatedAt: string; scheduledAt: string; readAt: string | null; channels: NotificationChannelState[]; failureCategory: string | null;
};
export type StreamInputJson = { name: string; type: "string" | "number" | "boolean" | "url"; required: boolean };
export type StreamWindowJson = { key: string; windowMinutes: number } | null;
export type StreamDefinitionJson = {
  inputs: StreamInputJson[]; recipients: Array<"user" | "organization_role">; routes: { in_app?: { default: boolean }; email?: { default: boolean } };
  strategy: "parallel" | "fallback"; policy: "user" | "organization" | "mandatory"; templates: { title: string; body: string; link?: string };
  grouping?: StreamWindowJson; dedupe?: StreamWindowJson; delayMinutes?: number; digestMinutes?: number | null;
};
export type StreamSummary = { type: string; name: string; description: string; archivedAt: string | null; activeVersion: number | null; publishedAt: string | null; draftVersion: number | null; routes: string[]; policy: string };
export type StreamVersionJson = { version: number; state: "draft" | "active" | "superseded" | "archived"; definition: StreamDefinitionJson; createdBy: string; createdAt: string | null; updatedAt: string | null; publishedAt: string | null; publishedBy: string | null };
export type StreamDetail = {
  stream: { type: string; name: string; description: string; createdBy: string; createdAt: string | null; archivedAt: string | null; archivedBy: string | null };
  versions: StreamVersionJson[]; draft: StreamVersionJson | null; active: StreamVersionJson | null; problems: string[]; recent: NotificationSummary[]; audit: AuditEventJson[];
};
export type StreamPreview = { title: string; body: string; link: string | null; problems: string[] };
export type NotificationTypeJson = { type: string; name: string; channels: string[]; mandatory: string[]; operatorActions: { retry?: boolean; cancel?: boolean } };
export type NotificationDetail = {
  notification: Omit<NotificationSummary, "channels" | "failureCategory"> & { groupKey: string | null; dedupeKey: string | null; eventId: string | null };
  deliveries: Array<{ id: string; channel: string; status: string; preferenceSource: string; mandatory: boolean; attempts: number; failureCategory: string | null; emailDeliveryId: string | null; providerStatus: string | null; createdAt: string; completedAt: string | null; nextAttemptAt: string | null }>;
  preferences: Array<{ scope: "organization" | "user"; channel: string; enabled: boolean }>;
  definition: { name: string; group: { windowMinutes: number } | null; dedupe: { windowMinutes: number } | null; mandatory: string[]; operatorActions: { retry?: boolean; cancel?: boolean } } | null;
};
export type CapabilityStatus = { id: CapabilityId; label: string; state: CapabilityState; healthy: boolean; mode?: string; message?: string; repair?: string };
export type ProviderMode = { mode: string; healthy?: boolean; detail?: string };
export type Overview = {
  environment: Environment;
  capabilities: CapabilityStatus[];
  providers: { email: ProviderMode | string; payments: ProviderMode | string };
  migrations: { applied: number; pending?: number; latest?: string };
  counts: { organizations: number; users: number; deadLetters: number };
  /** Things to act on, most severe first, each linked to the affected resource. */
  exceptions?: OverviewException[];
};
export type OverviewException = { kind: string; severity: "critical" | "warning"; title: string; detail: string; href: string; count?: number };
export type OrganizationSummary = { id: string; name: string; slug: string; createdAt: string; members: number; plan?: string; status?: string };
export type OrganizationMember = { memberId: string; userId: string; email: string; name: string; organizationRoles: string[]; applicationRoles: string[] };
export type UserSummary = {
  id: string; email: string; name: string; emailVerified: boolean; banned: boolean; createdAt: string;
  memberships: { organizationId: string; organizationName?: string; organizationRoles: string[]; applicationRoles: string[] }[];
  platformRoles: string[];
};
export type PlanVersionJson = Jsonify<PlanVersion>;
export type SubscriptionSummary = {
  organizationId: string; organizationName?: string; plan: string; planVersion?: string; status: string; provider: string;
  providerSubscriptionId?: string; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean; updatedAt?: string;
};
export type SubscriptionOverrideJson = {
  id: string; organizationId: string; code: string; enabled: boolean; values: Record<string, PrivilegeValue>;
  reason: string; author: string; effectiveAt: string; expiresAt?: string | null; removedAt?: string | null;
};
export type ScheduledChange = { id: string; toPlanVersion: string; effectiveAt: string; reason?: string; author?: string; status?: string };
export type ReconciliationRecord = Jsonify<ReconciliationResult> & { id?: string; ranAt?: string; actor?: string };
export type SubscriptionDetail = {
  subscription: SubscriptionSummary | null;
  planVersion: PlanVersionJson | null;
  overrides: SubscriptionOverrideJson[];
  scheduledChanges: ScheduledChange[];
  reconciliations: ReconciliationRecord[];
  effective: EffectiveEntitlement[];
  history?: { id: string; name: string; occurredAt: string; actor?: string; summary?: string }[];
  chain?: ProviderChain | null;
};
export type BillingMapping = {
  id: string; environment: string; provider: string; kind: "product" | "price"; plan: string; planVersion: number | null; offer: string | null; externalId: string;
  verifiedAt: string | null; verification: { state?: "verified" | "unverified" | "failed"; reason?: string; currency?: string; unitAmount?: number | null; interval?: string; livemode?: boolean; product?: string } | null; createdBy: string; createdAt: string;
};
export type ProviderChain = {
  environment: string; provider: string; product: BillingMapping | null; prices: BillingMapping[]; customerId: string | null; subscriptionId: string | null;
  lines: Array<{ id: string; planVersion: string; offer: string | null; quantity: number; providerItemId: string | null; providerPriceId: string | null; mapping: BillingMapping | null }>;
  reconciliation: ReconciliationRecord | null;
};
export type AuthorityPlane = "organization" | "application" | "platform";
export type PermissionJson = { code: string; description: string; principals: string[]; plane: AuthorityPlane; entitlement?: string; group: string; deprecated?: string; enforcedBy: string[] };
export type RoleJson = { key: string; name: string; description: string; plane: AuthorityPlane; permissions: string[]; custom: boolean };
/** A role in the managed catalog: built-in (code), global catalog, or archived catalog role. */
export type CatalogRoleJson = RoleJson & { source: "builtin" | "catalog" | "tenant"; archived: boolean; basedOn: string | null; assignments: number };
export type CatalogPermissionJson = {
  code: string; name: string; description: string; plane: AuthorityPlane; principals: string[]; entitlement: string | null;
  origin: "code" | "runtime"; state: "active" | "deprecated" | "invalid"; secret: boolean; protected: boolean;
  roles: Array<{ plane: AuthorityPlane; key: string; name: string }>; enforcedBy: string[]; createdAt: string | null; createdBy: string | null;
};
export type RoleAssignmentJson = { kind: "member" | "user" | "service_account"; id: string; organizationId: string; organizationName: string; principalId: string; name: string; detail: string };
export type ServiceAccountDetail = {
  account: ServiceAccount & { description: string; suspendedAt: string | null; suspensionReason: string | null; deletedAt: string | null; deletedBy: string | null; deletionReason: string | null };
  keys: ApiKeyMetadata[];
  effectivePermissions: Array<{ code: string; via: string[] }>;
  unknownRoles: string[];
  usage: Record<string, { requests: number; denied: number }>;
  audit: AuditEventJson[];
  availableRoles: Array<{ key: string; name: string; source: string }>;
};
export type AuditEventJson = { id: string; occurredAt: string; name: string; actorType: string; actor: string; reason: string | null; outcome: string; correlationId: string; targetId?: string };
export type IssuedKey = { id: string; displayPrefix: string; token: string | null; replayed?: boolean; previous?: { id: string; expiresAt: string } };
export type RoutePolicyJson = { method: string; path: string; public?: boolean; permission?: string; entitlement?: string; principals?: string[]; audience: string; acceptsApiKeys?: boolean };
export type PlatformRoleAssignment = { id: string; userId: string; email?: string; name?: string; role: string; grantedAt: string; grantedBy: string; reason: string; revokedAt?: string | null; revokedBy?: string | null };
export type ApplicationRoleAssignmentJson = { organizationId: string; organizationName?: string; userId: string; email?: string; name?: string; role: string; grantedAt: string; grantedBy: string };
export type ExplainRequest = { organizationId: string; principal: { type: "user" | "service_account"; id: string }; permission?: string; entitlement?: string; apiKeyId?: string };
export type ExplainResponse = { decision: AccessDecision; explanation: string };
export type ServiceAccount = { id: string; organizationId: string; organizationName?: string; name: string; description?: string; status: "active" | "suspended" | "deleted"; applicationRoles: string[]; createdAt: string; createdBy?: string; deletedAt?: string | null };
export type ApiKeyMetadata = {
  id: string; organizationId: string; serviceAccountId: string; name?: string; displayPrefix: string;
  environment: Environment; scopes: string[]; status: string; createdAt: string; createdBy?: string;
  lastUsedAt?: string | null; expiresAt?: string | null; revokedAt?: string | null; rotatedFrom?: string | null;
  organizationName?: string; serviceAccountName?: string; rotatedTo?: string | null; replacedBy?: string | null; revocationReason?: string | null; allowedCidrs?: string[] | null;
};
export type EmailDelivery = { id: string; provider: string; template: string; recipient: string; status: string; correlationId: string; failureCategory?: string; occurredAt: string; events: number };
export type EmailDeliveryDetail = {
  delivery: { id: string; provider: string; template: string; recipient: string; recipientCount: number; status: string; failureCategory: string | null; correlationId: string | null; organizationId: string | null; organizationName: string | null; createdAt: string };
  events: Array<{ status: string; occurredAt: string; receivedAt: string }>;
  notification: { deliveryId: string; type: string; attempts: number; status: string; failureCategory: string | null } | null;
};
export type AsyncState = { outbox: { pending: number; leased: number; succeeded: number; dead: number }; dead: DeadLetter[] };
export type DeadLetter = { id: string; event: string; attempts: number; lastErrorCategory: string; availableAt: string };
export type Artifact = { id: string; organizationId: string; contentType: string; size: number; createdAt: string; deletedAt: string | null; retention: string };
export type AuditEvent = {
  id: string; name: string; occurredAt: string; actor: string; actorType?: string; actorEmail?: string; organizationId?: string | null; organizationName?: string;
  target?: string; reason?: string; outcome?: string; correlationId?: string; environment?: string; supportSessionId?: string;
};
export type HealthCheck = { name: string; status: "ok" | "degraded" | "failed" | string; detail?: string };
export type ActionFailure = { target: string; message: string };
export type ActionOutcome = { succeeded?: string[]; failed?: ActionFailure[] };
export type { EffectiveEntitlement, Feature, PlanVersionState, QuotaState };

/* Errors */

const errorEnvelope = z.object({ error: z.string(), reason: z.string().optional(), message: z.string().optional(), required: z.enum(["password", "mfa", "phishing_resistant"]).optional() }).passthrough();

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly reason?: string) {
    super(message);
    this.name = "AdminApiError";
  }
}
export class StepUpRequired extends AdminApiError {
  constructor(message = "Re-authenticate to continue with this sensitive action.", readonly required: "password" | "mfa" | "phishing_resistant" = "password") {
    super(428, "step_up_required", message);
    this.name = "StepUpRequired";
  }
}
export class PermissionDenied extends AdminApiError {
  constructor(reason?: string) {
    super(403, "forbidden", "Your platform role does not permit this action. Ask a security administrator for the required platform permission.", reason);
    this.name = "PermissionDenied";
  }
}
export class Unauthenticated extends AdminApiError {
  constructor() {
    super(401, "unauthorized", "Your admin session has ended. Sign in again.");
    this.name = "Unauthenticated";
  }
}

export async function toApiError(response: Response): Promise<AdminApiError> {
  const parsed = errorEnvelope.safeParse(await response.json().catch(() => null));
  const body = parsed.success ? parsed.data : undefined;
  if (response.status === 428 || body?.error === "step_up_required") return new StepUpRequired(body?.message, body?.required ?? "password");
  if (response.status === 401) return new Unauthenticated();
  if (response.status === 403) return new PermissionDenied(body?.reason);
  return new AdminApiError(response.status, body?.error ?? "request_failed", body?.message ?? `Request failed (${response.status})`, body?.reason);
}

export function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}

/* Client */

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type RegionalSettingJson = "language" | "locale" | "timeZone" | "currency";
export type RegionalSourceJson = "operation" | "user" | "organization" | "application";
export type RegionalResolvedJson = Record<RegionalSettingJson, { value: string; source: RegionalSourceJson }>;
export type RegionalConfiguredJson = Record<RegionalSettingJson, string | null>;
export type OrganizationRegionalJson = {
  configured: RegionalConfiguredJson; effective: RegionalResolvedJson; application: Record<RegionalSettingJson, string>;
  organizationSettings: boolean; i18n: { enabled: boolean; languages: string[] }; languages: string[];
  applicationIssues: Array<{ message: string; repair: string }>; members: Array<{ userId: string; name: string; email: string }>; canRecover: boolean;
};
export type RegionalResolutionJson = { user: { userId: string; name: string }; configured: Omit<RegionalConfiguredJson, "currency">; effective: RegionalResolvedJson; organization: RegionalResolvedJson };

type Query = Record<string, string | undefined>;
export type Reasoned = { reason: string };

export const reasonSchema = z.string().trim().min(1, "A reason is required").max(500, "Keep the reason under 500 characters");

const withQuery = (path: string, query?: Query) => {
  const search = new URLSearchParams(Object.entries(query ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
  const text = search.toString();
  return text ? `${path}?${text}` : path;
};
const segment = encodeURIComponent;

export function createAdminApi(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
  const base = (options.baseUrl ?? "").replace(/\/$/u, "");
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  async function request<T>(method: Method, path: string, body?: unknown, query?: Query): Promise<T> {
    const response = await doFetch(`${base}/api/admin/${withQuery(path, query)}`, {
      method,
      credentials: "include",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await toApiError(response);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
  const reasoned = (reason: string) => ({ reason: reasonSchema.parse(reason) });
  return {
    request,
    session: () => request<AdminSession>("GET", "session"),
    capabilities: () => request<{ capabilities: CapabilityStatus[] }>("GET", "capabilities"),
    overview: () => request<Overview>("GET", "overview"),
    organizations: (q?: string) => request<{ organizations: OrganizationSummary[] }>("GET", "organizations", undefined, { q }),
    organization: (id: string) => request<{ organization: OrganizationSummary; members: OrganizationMember[] }>("GET", `organizations/${segment(id)}`),
    organizationRegional: (id: string) => request<OrganizationRegionalJson>("GET", `organizations/${segment(id)}/regional`),
    resolveRegional: (id: string, userId: string) => request<RegionalResolutionJson>("GET", `organizations/${segment(id)}/regional/resolve`, undefined, { userId }),
    recoverRegional: (id: string, input: RegionalConfiguredJson, reason: string) => request<OrganizationRegionalJson>("PUT", `organizations/${segment(id)}/regional`, { ...input, ...reasoned(reason) }),
    supportProfiles: () => request<{ profiles: SupportProfile[]; durations: number[] }>("GET", "support/profiles"),
    previewSupport: (organizationId: string, profile: string) => request<{ profile: SupportProfile; permissions: SupportPermissionPreview[] }>("POST", "support/preview", { organizationId, profile }),
    startSupportSession: (input: { organizationId: string; profile: string; durationMinutes: number; ticket?: string }, reason: string) => request<{ session: SupportSession }>("POST", "support/sessions", { ...input, ...reasoned(reason) }),
    exitSupportSession: () => request<void>("DELETE", "support/sessions/current"),
    supportSessions: (status?: "active") => request<{ sessions: SupportSessionSummary[] }>("GET", "support/sessions", undefined, { status }),
    supportSession: (id: string) => request<{ session: SupportSession & { operator: Operator }; activity: SupportActivity[] }>("GET", `support/sessions/${segment(id)}`),
    revokeSupportSession: (id: string, reason: string) => request<ActionOutcome>("POST", `support/sessions/${segment(id)}/revoke`, reasoned(reason)),
    supportTenant: () => request<{ session: SupportSession; permitted: string[] }>("GET", "support/tenant"),
    supportMembers: () => request<{ members: Array<{ memberId: string; userId: string; name: string; organizationRoles: string[] }> }>("GET", "support/tenant/members"),
    supportWebhooks: () => request<{ endpoints: Array<{ id: string; name: string; url: string; events: string[]; state: string; health: string; consecutiveFailures: number; lastSuccessAt: string | null; lastFailureAt: string | null }> }>("GET", "support/tenant/webhooks"),
    supportWebhookDeliveries: (id: string) => request<{ deliveries: Array<{ id: string; event: string; status: string; attempts: number; responseCode: number | null; failureCategory: string | null; test: boolean; createdAt: string }> }>("GET", `support/tenant/webhooks/${segment(id)}`),
    supportWebhookAction: (id: string, action: "pause" | "resume" | "test") => request<ActionOutcome>("POST", `support/tenant/webhooks/${segment(id)}/${action}`),
    supportReplay: (deliveryId: string) => request<ActionOutcome>("POST", `support/tenant/webhook-deliveries/${segment(deliveryId)}/replay`),
    supportNotificationDeliveries: () => request<{ deliveries: Array<{ id: string; type: string; channel: string; status: string; preference: string; failureCategory: string | null; createdAt: string }> }>("GET", "support/tenant/notification-deliveries"),
    supportAudit: () => request<{ events: Array<{ id: string; occurredAt: string; name: string; actorType: string; actorId: string; targetType: string; targetId: string; reason: string | null; outcome: string; correlationId: string }> }>("GET", "support/tenant/audit"),
    webhooks: (filter: { organizationId?: string; state?: string; q?: string; deleted?: string }) => request<{ endpoints: WebhookEndpointSummary[] }>("GET", "webhooks", undefined, filter),
    webhookEventTypes: () => request<{ eventTypes: Array<{ name: string; version: number; description: string }> }>("GET", "webhook-event-types"),
    webhook: (id: string) => request<{ endpoint: WebhookEndpointDetail; deliveries: Array<Omit<WebhookDeliveryJson, "history">>; attempts: Record<string, Array<WebhookAttemptJson & { providerReference?: string | null }>> }>("GET", `webhooks/${segment(id)}`),
    createWebhook: (input: { organizationId: string; name: string; url: string; events: string[]; description?: string | null; timeoutMs?: number }, reason: string) => request<{ endpoint: WebhookEndpointDetail; secret: string }>("POST", "webhooks", { ...input, ...reasoned(reason) }),
    updateWebhook: (id: string, input: { name: string; url?: string; events: string[]; description?: string | null; timeoutMs?: number }, reason: string) => request<undefined>("PATCH", `webhooks/${segment(id)}`, { ...input, ...reasoned(reason) }),
    webhookAction: (id: string, action: "pause" | "resume" | "test", reason: string) => request<{ deliveryId?: string } | undefined>("POST", `webhooks/${segment(id)}/${action}`, reasoned(reason)),
    rotateWebhookSecret: (id: string, overlapHours: number, reason: string) => request<{ secret: string; fingerprint: string; previousExpiresAt: string }>("POST", `webhooks/${segment(id)}/rotate-secret`, { overlapHours, ...reasoned(reason) }),
    deleteWebhook: (id: string, reason: string) => request<undefined>("DELETE", `webhooks/${segment(id)}`, reasoned(reason)),
    webhookDeliveries: (id: string) => request<{ deliveries: WebhookDeliveryJson[] }>("GET", `webhooks/${segment(id)}/deliveries`),
    disableWebhook: (id: string, reason: string) => request<ActionOutcome>("POST", `webhooks/${segment(id)}/disable`, reasoned(reason)),
    replayWebhookDelivery: (id: string, reason: string) => request<ActionOutcome>("POST", `webhook-deliveries/${segment(id)}/replay`, reasoned(reason)),
    notificationStreams: () => request<{ streams: StreamSummary[]; code: Array<{ type: string; name: string; description: string; routes: string[]; mandatory: string[] }> }>("GET", "notification-streams"),
    notificationStream: (type: string) => request<StreamDetail>("GET", `notification-streams/${segment(type)}`),
    createNotificationStream: (input: { type: string; name: string; description: string }, reason: string) => request<StreamDetail>("POST", "notification-streams", { ...input, ...reasoned(reason) }),
    renameNotificationStream: (type: string, input: { name: string; description: string }, reason: string) => request<void>("PATCH", `notification-streams/${segment(type)}`, { ...input, ...reasoned(reason) }),
    saveStreamDraft: (type: string, definition: StreamDefinitionJson) => request<{ problems: string[] }>("PUT", `notification-streams/${segment(type)}/draft`, { definition }),
    createStreamDraft: (type: string, reason: string) => request<{ version: number }>("POST", `notification-streams/${segment(type)}/drafts`, reasoned(reason)),
    discardStreamDraft: (type: string, reason: string) => request<void>("DELETE", `notification-streams/${segment(type)}/draft`, reasoned(reason)),
    publishStream: (type: string, reason: string) => request<void>("POST", `notification-streams/${segment(type)}/publish`, reasoned(reason)),
    setStreamArchived: (type: string, archived: boolean, reason: string) => request<void>("POST", `notification-streams/${segment(type)}/${archived ? "archive" : "restore"}`, reasoned(reason)),
    previewStream: (type: string, input: { definition?: StreamDefinitionJson; version?: number; data: Record<string, string | number | boolean | null> }) => request<StreamPreview>("POST", `notification-streams/${segment(type)}/preview`, input),
    testStream: (type: string, input: { organizationId: string; userId: string; version?: number; data: Record<string, string | number | boolean | null> }, reason: string) => request<{ created: number; version: number }>("POST", `notification-streams/${segment(type)}/test`, { ...input, ...reasoned(reason) }),
    notifications: (filter: { organizationId?: string; status?: string; type?: string }) => request<{ notifications: NotificationSummary[]; types: NotificationTypeJson[] }>("GET", "notifications", undefined, filter),
    notification: (id: string) => request<NotificationDetail>("GET", `notifications/${segment(id)}`),
    notificationDeliveryAction: (id: string, action: "retry" | "cancel", reason: string) => request<ActionOutcome>("POST", `notification-deliveries/${segment(id)}/${action}`, reasoned(reason)),
    users: (q?: string) => request<{ users: UserSummary[] }>("GET", "users", undefined, { q }),
    suspendUser: (id: string, reason: string) => request<ActionOutcome | undefined>("POST", `users/${segment(id)}/suspend`, reasoned(reason)),
    restoreUser: (id: string, reason: string) => request<ActionOutcome | undefined>("POST", `users/${segment(id)}/restore`, reasoned(reason)),
    revokeSessions: (id: string, reason: string) => request<ActionOutcome | undefined>("POST", `users/${segment(id)}/sessions/revoke`, reasoned(reason)),
    features: () => request<{ features: Feature[] }>("GET", "features"),
    plans: () => request<{ versions: PlanVersionJson[] }>("GET", "plans"),
    authPolicy: () => request<AuthPolicyState>("GET", "auth-policy"),
    createAuthPolicyDraft: (reason: string) => request<{ version: number }>("POST", "auth-policy/drafts", reasoned(reason)),
    saveAuthPolicyDraft: (policy: AuthPolicy) => request<{ shape: string[]; safeguards: string[]; impact: string[] }>("PUT", "auth-policy/draft", { policy }),
    discardAuthPolicyDraft: (reason: string) => request<void>("DELETE", "auth-policy/draft", reasoned(reason)),
    activateAuthPolicyDraft: (reason: string) => request<{ impact: string[] }>("POST", "auth-policy/draft/activate", reasoned(reason)),
    rollbackAuthPolicy: (version: number, reason: string) => request<{ impact: string[] }>("POST", `auth-policy/versions/${version}/rollback`, reasoned(reason)),
    billingMappings: (plan?: string) => request<{ environment: string; stripe: "configured" | "unconfigured"; mappings: BillingMapping[] }>("GET", "billing-mappings", undefined, { plan }),
    connectBillingMapping: (input: { kind: "product" | "price"; plan: string; planVersion?: number | null; offer?: string | null; externalId: string }, reason: string) => request<{ verification: BillingMapping["verification"] }>("POST", "billing-mappings", { ...input, ...reasoned(reason) }),
    createBillingMapping: (input: { kind: "product" | "price"; plan: string; planVersion?: number | null; offer?: string | null; unitAmount?: number; currency?: string; interval?: "month" | "year" }, reason: string) => request<{ externalId: string; verification: BillingMapping["verification"] }>("POST", "billing-mappings/create", { ...input, ...reasoned(reason) }),
    verifyBillingMapping: (id: string) => request<{ verification: BillingMapping["verification"] }>("POST", `billing-mappings/${segment(id)}/verify`, {}),
    disconnectBillingMapping: (id: string, reason: string) => request<void>("DELETE", `billing-mappings/${segment(id)}`, reasoned(reason)),
    draftPlanVersion: (plan: string, reason: string) => request<PlanVersionJson>("POST", `plans/${segment(plan)}/versions`, reasoned(reason)),
    updateDraft: (plan: string, version: number, changes: { name?: string; entitlements?: PlanVersionJson["entitlements"] }) => request<PlanVersionJson>("PATCH", `plans/${segment(plan)}/versions/${version}`, changes),
    transitionPlanVersion: (plan: string, version: number, to: PlanVersionState, reason: string) => request<PlanVersionJson>("POST", `plans/${segment(plan)}/versions/${version}/transition`, { to, ...reasoned(reason) }),
    subscriptions: (q?: string) => request<{ subscriptions: SubscriptionSummary[] }>("GET", "subscriptions", undefined, { q }),
    subscription: (organizationId: string) => request<SubscriptionDetail>("GET", `subscriptions/${segment(organizationId)}`),
    addOverride: (organizationId: string, input: { code: string; enabled: boolean; values: Record<string, PrivilegeValue>; effectiveAt: string; expiresAt?: string }, reason: string) =>
      request<SubscriptionOverrideJson>("POST", `subscriptions/${segment(organizationId)}/overrides`, { ...input, ...reasoned(reason) }),
    removeOverride: (organizationId: string, id: string, reason: string) => request<ActionOutcome | undefined>("DELETE", `subscriptions/${segment(organizationId)}/overrides/${segment(id)}`, reasoned(reason)),
    reconcile: (organizationId: string, reason: string) => request<ReconciliationRecord>("POST", `subscriptions/${segment(organizationId)}/reconcile`, reasoned(reason)),
    scheduleChange: (organizationId: string, input: { toPlanVersion: string; effectiveAt: string }, reason: string) => request<ScheduledChange>("POST", `subscriptions/${segment(organizationId)}/changes`, { ...input, ...reasoned(reason) }),
    entitlements: (organizationId: string) => request<EntitlementExplorer>("GET", `entitlements/${segment(organizationId)}`),
    compareEntitlements: (organizationId: string, input: { planVersion?: string; removeOverrides?: string[]; overrides?: Array<{ code: string; enabled: boolean; values: Record<string, PrivilegeValue>; expiresAt?: string }> }) => request<{ from: string | null; to: string | null; changes: EntitlementChange[] }>("POST", `entitlements/${segment(organizationId)}/compare`, input),
    simulateEntitlements: (input: { planVersion: string; overrides: { code: string; enabled: boolean; values: Record<string, PrivilegeValue> }[] }) => request<{ effective: EffectiveEntitlement[] }>("POST", "entitlements/simulate", input),
    permissions: () => request<{ permissions: PermissionJson[] }>("GET", "permissions"),
    roles: () => request<{ organization: RoleJson[]; application: RoleJson[]; platform: RoleJson[] }>("GET", "roles"),
    applicationRoleAssignments: (organizationId?: string) => request<{ assignments: ApplicationRoleAssignmentJson[] }>("GET", "application-role-assignments", undefined, { organizationId }),
    routePolicies: () => request<{ routes: RoutePolicyJson[] }>("GET", "route-policies"),
    platformRoles: (includeRevoked = false) => request<{ assignments: PlatformRoleAssignment[] }>("GET", "platform-roles", undefined, { history: includeRevoked ? "1" : undefined }),
    assignPlatformRole: (userId: string, role: string, reason: string) => request<ActionOutcome | undefined>("POST", "platform-roles", { userId, role, ...reasoned(reason) }),
    revokePlatformRole: (userId: string, role: string, reason: string) => request<ActionOutcome | undefined>("DELETE", `platform-roles/${segment(userId)}/${segment(role)}`, reasoned(reason)),
    explainAccess: (input: ExplainRequest) => request<ExplainResponse>("POST", "access/explain", input),
    serviceAccounts: (organizationId?: string) => request<{ serviceAccounts: ServiceAccount[] }>("GET", "service-accounts", undefined, { organizationId }),
    suspendServiceAccount: (id: string, reason: string) => request<ActionOutcome | undefined>("POST", `service-accounts/${segment(id)}/suspend`, reasoned(reason)),
    apiKeys: (organizationId?: string) => request<{ apiKeys: ApiKeyMetadata[] }>("GET", "api-keys", undefined, { organizationId }),
    revokeApiKey: (id: string, reason: string) => request<ActionOutcome | undefined>("POST", `api-keys/${segment(id)}/revoke`, reasoned(reason)),
    createPlan: (input: { name: string; key: string }, reason: string) => request<PlanVersionJson>("POST", "plans", { ...input, ...reasoned(reason) }),
    catalog: () => request<{ permissions: CatalogPermissionJson[]; roles: { organization: CatalogRoleJson[]; application: CatalogRoleJson[] } }>("GET", "catalog"),
    roleAssignments: (plane: "organization" | "application", key: string) => request<{ assignments: RoleAssignmentJson[] }>("GET", `catalog/roles/${plane}/${segment(key)}/assignments`),
    permissionReferences: (code: string) => request<{ tenantRoles: Array<{ organizationId: string; organizationName: string; key: string; name: string }>; activeKeys: number }>("GET", `catalog/permissions/${segment(code)}/references`),
    createPermission: (input: { code: string; name: string; description: string; plane: "organization" | "application"; principals: string[]; entitlement: string | null }, reason: string) => request<{ code: string }>("POST", "catalog/permissions", { ...input, ...reasoned(reason) }),
    updatePermission: (code: string, input: { name: string; description: string; principals: string[]; entitlement: string | null }, reason: string) => request<undefined>("PATCH", `catalog/permissions/${segment(code)}`, { ...input, ...reasoned(reason) }),
    setPermissionState: (code: string, action: "deprecate" | "restore", reason: string) => request<undefined>("POST", `catalog/permissions/${segment(code)}/${action}`, reasoned(reason)),
    deletePermission: (code: string, reason: string) => request<undefined>("DELETE", `catalog/permissions/${segment(code)}`, reasoned(reason)),
    createRole: (input: { plane: "organization" | "application"; key: string; name: string; description: string; permissions: string[]; basedOn?: string }, reason: string) => request<{ key: string }>("POST", "catalog/roles", { ...input, ...reasoned(reason) }),
    updateRole: (plane: "organization" | "application", key: string, input: { name: string; description: string; permissions: string[] }, reason: string) => request<undefined>("PATCH", `catalog/roles/${plane}/${segment(key)}`, { ...input, ...reasoned(reason) }),
    setRoleArchived: (plane: "organization" | "application", key: string, action: "archive" | "restore", reason: string) => request<undefined>("POST", `catalog/roles/${plane}/${segment(key)}/${action}`, reasoned(reason)),
    deleteRole: (plane: "organization" | "application", key: string, reason: string) => request<undefined>("DELETE", `catalog/roles/${plane}/${segment(key)}`, reasoned(reason)),
    setMemberOrganizationRoles: (organizationId: string, memberId: string, roles: string[], reason: string) => request<undefined>("POST", `organizations/${segment(organizationId)}/members/${segment(memberId)}/organization-roles`, { roles, ...reasoned(reason) }),
    setUserApplicationRoles: (organizationId: string, userId: string, roles: string[], reason: string) => request<undefined>("POST", `organizations/${segment(organizationId)}/users/${segment(userId)}/application-roles`, { roles, ...reasoned(reason) }),
    serviceAccount: (id: string) => request<ServiceAccountDetail>("GET", `service-accounts/${segment(id)}`),
    createServiceAccount: (input: { organizationId: string; name: string; description?: string; applicationRoles: string[] }, reason: string) => request<{ id: string }>("POST", "service-accounts", { ...input, ...reasoned(reason) }),
    updateServiceAccount: (id: string, input: { name: string; description: string; applicationRoles?: string[] }, reason: string) => request<undefined>("PATCH", `service-accounts/${segment(id)}`, { ...input, ...reasoned(reason) }),
    reactivateServiceAccount: (id: string, reason: string) => request<undefined>("POST", `service-accounts/${segment(id)}/reactivate`, reasoned(reason)),
    deleteServiceAccount: (id: string, reason: string) => request<{ revokedKeys: number }>("DELETE", `service-accounts/${segment(id)}`, reasoned(reason)),
    apiKeyScopes: () => request<{ scopes: Array<{ code: string; name: string; description: string; entitlement: string | null }> }>("GET", "api-key-scopes"),
    apiKey: (id: string) => request<{ key: ApiKeyMetadata; lineage: ApiKeyMetadata[]; usage: Array<{ day: string; requests: number; denied: number }>; audit: AuditEventJson[]; serviceAccount: ServiceAccountDetail["account"] | null }>("GET", `api-keys/${segment(id)}`),
    createApiKey: (input: { serviceAccountId: string; name: string; scopes: string[]; expiresAt?: string; allowedCidrs?: string[]; idempotencyKey: string }, reason: string) => request<IssuedKey>("POST", "api-keys", { ...input, ...reasoned(reason) }),
    rotateApiKey: (id: string, overlapHours: number, reason: string) => request<IssuedKey>("POST", `api-keys/${segment(id)}/rotate`, { overlapHours, ...reasoned(reason) }),
    replaceApiKey: (id: string, scopes: string[], overlapHours: number, reason: string) => request<IssuedKey>("POST", `api-keys/${segment(id)}/replace`, { scopes, overlapHours, ...reasoned(reason) }),
    identity: () => request<IdentityStatus>("GET", "identity"),
    email: (status?: string) => request<{ deliveries: EmailDelivery[] }>("GET", "email", undefined, { status }),
    emailDelivery: (id: string) => request<EmailDeliveryDetail>("GET", `email/${segment(id)}`),
    async: () => request<AsyncState>("GET", "async"),
    redrive: (id: string, reason: string) => request<ActionOutcome | undefined>("POST", `async/dead/${segment(id)}/redrive`, reasoned(reason)),
    artifacts: (organizationId?: string) => request<{ artifacts: Artifact[] }>("GET", "artifacts", undefined, { organizationId }),
    audit: (filters: { organizationId?: string; actor?: string; name?: string; correlation?: string; page?: string; pageSize?: string }) => request<{ events: AuditEvent[]; total: number; page: number; pageSize: number }>("GET", "audit", undefined, filters),
    auditEvent: (id: string) => request<{ event: AuditEvent }>("GET", `audit/${segment(id)}`),
    health: () => request<{ checks: HealthCheck[] }>("GET", "health"),
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
export const api: AdminApi = createAdminApi();

/* Query keys are always scoped by environment and tenant context so cached state never crosses them. */

export type QueryScope = Readonly<{ environment: Environment; tenantContextId: string | null }>;
export const adminQueryKey = (scope: QueryScope, ...parts: readonly unknown[]) =>
  ["admin", scope.environment, scope.tenantContextId ?? "platform", ...parts] as const;
export const sessionQueryKey = ["admin-session"] as const;

/** Display helpers that never reveal secret material. */
export const maskedKeyPrefix = (displayPrefix: string, visible = 4): string => {
  const match = /^(tr_(?:live|test|dev)_)([A-Za-z0-9]+)/u.exec(displayPrefix);
  return match ? `${match[1]}${match[2]!.slice(0, visible)}…` : "hidden";
};
