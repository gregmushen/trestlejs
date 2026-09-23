import type { ApplicationEnvironment } from "@__TRESTLE_PROJECT_NAME__/authz";

export type Actor = Readonly<{ type: "user" | "service_account" | "platform_operator" | "system"; id: string }>;

/** Everything a tenant-administration operation needs besides its repository. */
export type OperationContext = Readonly<{
  organizationId: string;
  actor: Actor;
  correlationId: string;
  environment: ApplicationEnvironment;
  now: Date;
  /** Set when a platform operator acts in a support session; every record carries it. */
  support?: Readonly<{ sessionId: string; reason: string }>;
  /** The operator's stated reason for a direct platform action in this tenant. */
  reason?: string;
}>;

/** A safe audit record: summaries never contain tokens, verifiers, secrets, or message bodies. */
export type AuditRecord = Readonly<{
  name: string;
  targetType: string;
  targetId: string;
  reason?: string;
  summary: Readonly<Record<string, unknown>>;
  outcome: "succeeded" | "denied" | "failed";
}>;

/** Versioned domain event appended to the outbox in the same transaction as the mutation. */
export type DomainEvent = Readonly<{ name: string; resourceType: string; resourceId: string; payload: Readonly<Record<string, unknown>> }>;

/** Every repository write carries its audit record and event so they commit atomically. */
export type Mutation = Readonly<{ context: OperationContext; audit: AuditRecord; event: DomainEvent }>;

export type Member = Readonly<{ memberId: string; userId: string; name: string; email: string; organizationRoles: readonly string[] }>;
export type ApplicationRoleRecord = Readonly<{ key: string; name: string; description: string; permissions: readonly string[] }>;
export type ApplicationRoleAssignment = Readonly<{ userId: string; role: string; grantedBy: string; grantedAt: Date }>;
export type ServiceAccountRecord = Readonly<{ id: string; name: string; description: string; applicationRoles: readonly string[]; status: "active" | "suspended"; createdBy: string; createdAt: Date; deletedAt?: Date | null; suspensionReason?: string | null }>;

/** API-key metadata. The verifier is write-only and never part of a read model. */
export type ApiKeyMetadata = Readonly<{
  id: string;
  serviceAccountId: string;
  environment: ApplicationEnvironment;
  displayPrefix: string;
  scopes: readonly string[];
  expiresAt: Date | null;
  allowedCidrs: readonly string[] | null;
  rateLimitPerMinute: number | null;
  createdBy: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  rotatedFrom: string | null;
  rotatedTo: string | null;
  revokedAt: Date | null;
  /** Human-readable label chosen at creation. */
  name?: string | null;
  /** Set when a scope change issued a replacement key. */
  replacedBy?: string | null;
  revocationReason?: string | null;
}>;
export type NewApiKey = Omit<ApiKeyMetadata, "lastUsedAt" | "rotatedTo" | "revokedAt" | "replacedBy" | "revocationReason"> & Readonly<{ verifier: string; idempotencyKey?: string | null }>;
export type ScopeProfile = Readonly<{ id: string; name: string; description: string; scopes: readonly string[] }>;
export type AuditEntry = Readonly<{ id: string; occurredAt: Date; name: string; actorType: string; actorId: string; targetType: string; targetId: string; reason: string | null; outcome: string; correlationId: string }>;
export type ApiKeyUsageDay = Readonly<{ day: string; requests: number; denied: number }>;

export interface TenantAccessRepository {
  listMembers(): Promise<Member[]>;
  setMemberOrganizationRoles(memberId: string, roles: readonly string[], mutation: Mutation): Promise<void>;
  listApplicationRoles(): Promise<ApplicationRoleRecord[]>;
  saveApplicationRole(role: ApplicationRoleRecord, mutation: Mutation): Promise<void>;
  deleteApplicationRole(key: string, mutation: Mutation): Promise<void>;
  listApplicationRoleAssignments(userId?: string): Promise<ApplicationRoleAssignment[]>;
  setUserApplicationRoles(userId: string, roles: readonly string[], mutation: Mutation): Promise<void>;
  listServiceAccounts(): Promise<ServiceAccountRecord[]>;
  getServiceAccount(id: string): Promise<ServiceAccountRecord | null>;
  createServiceAccount(account: ServiceAccountRecord, mutation: Mutation): Promise<void>;
  setServiceAccountStatus(id: string, status: "active" | "suspended", reason: string | null, mutation: Mutation): Promise<void>;
  setServiceAccountRoles(id: string, roles: readonly string[], mutation: Mutation): Promise<void>;
  updateServiceAccount(id: string, changes: Readonly<{ name: string; description: string }>, mutation: Mutation): Promise<void>;
  /** Tombstones the account and revokes every active key in one transaction. */
  deleteServiceAccount(id: string, reason: string, mutation: Mutation): Promise<void>;
  findApiKeyByIdempotencyKey(idempotencyKey: string): Promise<ApiKeyMetadata | null>;
  listApiKeys(serviceAccountId?: string): Promise<ApiKeyMetadata[]>;
  getApiKey(id: string): Promise<ApiKeyMetadata | null>;
  insertApiKey(key: NewApiKey, mutation: Mutation): Promise<void>;
  rotateApiKey(previousId: string, previousExpiresAt: Date, replacement: NewApiKey, mutation: Mutation, replaced?: boolean): Promise<void>;
  revokeApiKey(id: string, reason: string, mutation: Mutation): Promise<void>;
  apiKeyUsage(id: string): Promise<ApiKeyUsageDay[]>;
  listScopeProfiles(): Promise<ScopeProfile[]>;
  createScopeProfile(profile: ScopeProfile, mutation: Mutation): Promise<void>;
  deleteScopeProfile(id: string, mutation: Mutation): Promise<void>;
  listAudit(limit: number): Promise<AuditEntry[]>;
}
