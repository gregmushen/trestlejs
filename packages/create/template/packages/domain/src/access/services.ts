import {
  applicationRoles,
  buildAccessCatalog,
  isValidCidr,
  mintApiKey,
  organizationCreatorAssignments,
  organizationRoles,
  permissions,
  rotationExpiry,
  validateApiKeyScopes,
  type AccessCatalog,
  type RoleCatalog,
} from "@__TRESTLE_PROJECT_NAME__/authz";

/** The reviewed registry and built-in roles only; runtimes pass the loaded catalog instead. */
export const codeAccessCatalog: AccessCatalog = buildAccessCatalog({ permissions, organization: organizationRoles, application: applicationRoles }, { permissions: [], roles: [] });

import type { ApiKeyMetadata, AuditRecord, DomainEvent, Mutation, NewApiKey, OperationContext, ServiceAccountRecord, TenantAccessRepository } from "./ports.js";

export class AccessDomainError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "conflict" | "limit_exceeded", message: string) {
    super(message);
    this.name = "AccessDomainError";
  }
}

const invalid = (message: string) => new AccessDomainError("invalid", message);

function mutation(context: OperationContext, audit: Omit<AuditRecord, "outcome">, payload: Record<string, unknown> = audit.summary): Mutation {
  const event: DomainEvent = { name: audit.name, resourceType: audit.targetType, resourceId: audit.targetId, payload: { organizationId: context.organizationId, ...payload } };
  return { context, audit: { ...audit, outcome: "succeeded" }, event };
}

function uniqueKeys(roles: readonly string[]): string[] {
  return [...new Set(roles.map((role) => role.trim()).filter(Boolean))].sort();
}

function requireKnownRoles(catalog: RoleCatalog, roles: readonly string[], plane: string): void {
  const unknown = roles.filter((role) => !catalog.get(role));
  if (unknown.length) throw invalid(`Unknown ${plane} roles: ${unknown.join(", ")}`);
}

/** Organization roles govern account administration only (spec §7.2). */
export class OrganizationRoleService {
  constructor(private readonly repository: TenantAccessRepository, private readonly access: AccessCatalog = codeAccessCatalog) {}

  async setMemberRoles(context: OperationContext, actorOrganizationRoles: readonly string[], memberId: string, requested: readonly string[]): Promise<void> {
    const roles = uniqueKeys(requested);
    if (roles.length === 0) throw invalid("A member must keep at least one organization role; remove the member instead");
    const members = await this.repository.listMembers();
    const member = members.find((candidate) => candidate.memberId === memberId);
    if (!member) throw new AccessDomainError("not_found", "Member not found");
    // Only newly added roles must exist; an archived role already held can stay (it grants nothing).
    requireKnownRoles(this.access.organization, roles.filter((role) => !member.organizationRoles.includes(role)), "organization");
    const touchesOwner = member.organizationRoles.includes("owner") !== roles.includes("owner");
    if (touchesOwner && !actorOrganizationRoles.includes("owner")) throw invalid("Only an organization owner can grant or remove the owner role");
    const remainingOwners = members.filter((candidate) => candidate.memberId !== memberId && candidate.organizationRoles.includes("owner")).length + (roles.includes("owner") ? 1 : 0);
    if (remainingOwners === 0) throw invalid("An organization must keep at least one owner");
    await this.repository.setMemberOrganizationRoles(memberId, roles, mutation(context, {
      name: "access.organization_roles.changed", targetType: "member", targetId: memberId,
      summary: { userId: member.userId, before: [...member.organizationRoles].sort(), after: roles },
    }));
  }
}

/** Application roles express product-domain authority, assigned independently of organization roles (spec §7.3). */
export class ApplicationRoleService {
  constructor(private readonly repository: TenantAccessRepository, readonly access: AccessCatalog = codeAccessCatalog) {}

  /** Built-in, global catalog, and this tenant's own application roles. */
  async catalog(): Promise<RoleCatalog> {
    return this.access.application.withCustomRoles(await this.repository.listApplicationRoles());
  }

  async saveCustomRole(context: OperationContext, input: { key: string; name: string; description?: string | undefined; permissions: readonly string[] }, mode: "create" | "update"): Promise<void> {
    const existing = await this.repository.listApplicationRoles();
    const current = existing.find((role) => role.key === input.key);
    if (mode === "create" && current) throw new AccessDomainError("conflict", `Application role ${input.key} already exists`);
    if (this.access.application.get(input.key)) throw new AccessDomainError("conflict", `${input.key} is a built-in or catalog role; choose another key`);
    if (mode === "update" && !current) throw new AccessDomainError("not_found", `Application role ${input.key} was not found`);
    if (!input.name.trim()) throw invalid("A role requires a name");
    const role = { key: input.key, name: input.name.trim(), description: input.description?.trim() ?? current?.description ?? "", permissions: [...new Set(input.permissions)].sort() };
    try {
      this.access.application.withCustomRoles([...existing.filter((candidate) => candidate.key !== role.key), role]);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
    await this.repository.saveApplicationRole(role, mutation(context, {
      name: mode === "create" ? "access.application_role.created" : "access.application_role.updated", targetType: "application_role", targetId: role.key,
      summary: { before: current?.permissions ?? null, after: role.permissions },
    }));
  }

  async deleteCustomRole(context: OperationContext, key: string): Promise<void> {
    if (this.access.application.get(key)) throw invalid(`${key} is a built-in or catalog application role and cannot be deleted here`);
    if (!(await this.repository.listApplicationRoles()).some((role) => role.key === key)) throw new AccessDomainError("not_found", `Application role ${key} was not found`);
    const holders = (await this.repository.listApplicationRoleAssignments()).filter((assignment) => assignment.role === key).length;
    await this.repository.deleteApplicationRole(key, mutation(context, { name: "access.application_role.deleted", targetType: "application_role", targetId: key, summary: { revokedAssignments: holders } }));
  }

  async assignUserRoles(context: OperationContext, userId: string, requested: readonly string[]): Promise<void> {
    const roles = uniqueKeys(requested);
    if (!(await this.repository.listMembers()).some((member) => member.userId === userId)) throw new AccessDomainError("not_found", "Application roles can only be assigned to current organization members");
    const before = (await this.repository.listApplicationRoleAssignments(userId)).map((assignment) => assignment.role).sort();
    requireKnownRoles(await this.catalog(), roles.filter((role) => !before.includes(role)), "application");
    await this.repository.setUserApplicationRoles(userId, roles, mutation(context, {
      name: "access.application_roles.assigned", targetType: "user", targetId: userId,
      summary: { before, after: roles },
    }));
  }
}

/**
 * Explicit cross-plane policy (packages/authz/src/policies.ts): the creator of
 * an organization receives the application-plane assignment once. Better Auth
 * already records the organization-plane owner membership.
 */
export async function applyOrganizationCreatorAssignments(repository: TenantAccessRepository, context: OperationContext, userId: string): Promise<void> {
  const roles = organizationCreatorAssignments.filter((assignment) => assignment.plane === "application").map((assignment) => assignment.role);
  const existing = (await repository.listApplicationRoleAssignments(userId)).map((assignment) => assignment.role);
  const next = uniqueKeys([...existing, ...roles]);
  if (next.length === existing.length) return;
  await repository.setUserApplicationRoles(userId, next, mutation(context, { name: "access.bootstrap.applied", targetType: "user", targetId: userId, summary: { policy: "organizationCreatorAssignments", applicationRoles: roles } }));
}

export type MintKeyInput = Readonly<{
  scopes: readonly string[];
  expiresAt?: Date | null;
  allowedCidrs?: readonly string[] | null;
  rateLimitPerMinute?: number | null;
  name?: string | null;
  /** A retry with the same key returns the original key's metadata and never a second secret. */
  idempotencyKey?: string | null;
  /** The acting administrator's own application authority; keys can never exceed it. Omitted for platform operators. */
  actorAuthority?: ReadonlySet<string>;
}>;
/** `token` is null when an idempotent retry matched an earlier request: the secret was shown then. */
export type MintedKey = Readonly<{ key: ApiKeyMetadata; token: string | null; replayed?: boolean }>;

/** Tenant-owned machine identities and their credentials (spec §8). */
export class ServiceAccountService {
  constructor(private readonly repository: TenantAccessRepository, private readonly roles: ApplicationRoleService = new ApplicationRoleService(repository)) {}

  private static validName(value: string): string {
    const name = value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/u.test(name)) throw invalid("Service account names use letters, numbers, spaces, dots, dashes, and underscores");
    return name;
  }

  private async requireUniqueName(name: string, exceptId?: string): Promise<void> {
    const taken = (await this.repository.listServiceAccounts()).some((account) => !account.deletedAt && account.id !== exceptId && account.name.toLowerCase() === name.toLowerCase());
    if (taken) throw new AccessDomainError("conflict", `A service account named ${name} already exists in this organization`);
  }

  async create(context: OperationContext, input: { name: string; description?: string | undefined; applicationRoles: readonly string[] }): Promise<ServiceAccountRecord> {
    const name = ServiceAccountService.validName(input.name);
    await this.requireUniqueName(name);
    const applicationRoleKeys = uniqueKeys(input.applicationRoles);
    if (applicationRoleKeys.length === 0) throw invalid("A service account requires at least one application role");
    requireKnownRoles(await this.roles.catalog(), applicationRoleKeys, "application");
    const account: ServiceAccountRecord = { id: `sa_${crypto.randomUUID().replaceAll("-", "")}`, name, description: input.description?.trim() ?? "", applicationRoles: applicationRoleKeys, status: "active", createdBy: context.actor.id, createdAt: context.now };
    await this.repository.createServiceAccount(account, mutation(context, { name: "access.service_account.created", targetType: "service_account", targetId: account.id, summary: { name, applicationRoles: applicationRoleKeys } }));
    return account;
  }

  async update(context: OperationContext, id: string, input: { name: string; description?: string | undefined }): Promise<void> {
    const account = await this.required(id);
    const name = ServiceAccountService.validName(input.name);
    await this.requireUniqueName(name, id);
    const description = input.description?.trim() ?? account.description;
    if (name === account.name && description === account.description) return;
    await this.repository.updateServiceAccount(id, { name, description }, mutation(context, { name: "access.service_account.updated", targetType: "service_account", targetId: id, summary: { before: { name: account.name, description: account.description }, after: { name, description } } }));
  }

  /** Deletion stops authentication at once: every key is revoked and the account remains as a tombstone. */
  async delete(context: OperationContext, id: string, reason: string): Promise<{ revokedKeys: number }> {
    if (!reason.trim()) throw invalid("Deleting a service account requires a reason");
    const account = await this.required(id);
    const revokedKeys = (await this.repository.listApiKeys(id)).filter((key) => !key.revokedAt).length;
    await this.repository.deleteServiceAccount(id, reason.trim(), mutation(context, { name: "access.service_account.deleted", targetType: "service_account", targetId: id, reason: reason.trim(), summary: { name: account.name, revokedKeys } }));
    return { revokedKeys };
  }

  async setStatus(context: OperationContext, id: string, status: "active" | "suspended", reason: string | null): Promise<void> {
    const account = await this.required(id);
    if (status === "suspended" && !reason?.trim()) throw invalid("Suspending a service account requires a reason");
    if (account.status === status) return;
    await this.repository.setServiceAccountStatus(id, status, reason?.trim() ?? null, mutation(context, {
      name: status === "suspended" ? "access.service_account.suspended" : "access.service_account.reactivated", targetType: "service_account", targetId: id,
      ...(reason?.trim() ? { reason: reason.trim() } : {}), summary: { status },
    }));
  }

  async setRoles(context: OperationContext, id: string, requested: readonly string[]): Promise<void> {
    const account = await this.required(id);
    const roles = uniqueKeys(requested);
    if (roles.length === 0) throw invalid("A service account requires at least one application role");
    const catalog = await this.roles.catalog();
    requireKnownRoles(catalog, roles.filter((role) => !account.applicationRoles.includes(role)), "application");
    const authority = catalog.resolve(roles).permissions;
    const exceeded = (await this.repository.listApiKeys(id)).filter((key) => !key.revokedAt).flatMap((key) => key.scopes.filter((scope) => !authority.has(scope)));
    if (exceeded.length) throw invalid(`Active API keys hold scopes the new roles would not grant: ${[...new Set(exceeded)].sort().join(", ")}; revoke or rotate them first`);
    await this.repository.setServiceAccountRoles(id, roles, mutation(context, { name: "access.service_account.roles_changed", targetType: "service_account", targetId: id, summary: { before: account.applicationRoles, after: roles } }));
  }

  async mintKey(context: OperationContext, serviceAccountId: string, input: MintKeyInput, maxActiveKeys: number | null): Promise<MintedKey> {
    if (input.idempotencyKey) {
      const existing = await this.repository.findApiKeyByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.serviceAccountId !== serviceAccountId) throw new AccessDomainError("conflict", "That request identifier was already used for another service account");
        return { key: existing, token: null, replayed: true };
      }
    }
    const account = await this.required(serviceAccountId);
    if (account.status !== "active") throw invalid("Suspended service accounts cannot receive new keys");
    const scopes = [...input.scopes].sort();
    const problems = validateApiKeyScopes(this.roles.access.permissions, scopes, (await this.roles.catalog()).resolve(account.applicationRoles).permissions);
    const beyondActor = input.actorAuthority ? scopes.filter((scope) => !input.actorAuthority!.has(scope)) : [];
    if (beyondActor.length) problems.push(`You cannot grant scopes you do not hold: ${beyondActor.join(", ")}`);
    if (problems.length) throw invalid(problems.join("; "));
    const name = input.name?.trim() || null;
    if (name && name.length > 80) throw invalid("Key names are at most 80 characters");
    if (input.expiresAt && input.expiresAt <= context.now) throw invalid("An API key must expire in the future");
    const cidrs = input.allowedCidrs?.length ? [...input.allowedCidrs] : null;
    if (cidrs?.some((cidr) => !isValidCidr(cidr))) throw invalid("Network restrictions must be IPv4 or IPv6 CIDR ranges");
    if (input.rateLimitPerMinute !== undefined && input.rateLimitPerMinute !== null && (!Number.isSafeInteger(input.rateLimitPerMinute) || input.rateLimitPerMinute < 1)) throw invalid("Rate limits must be a positive whole number per minute");
    await this.requireCapacity(context, maxActiveKeys);
    const minted = await mintApiKey(context.environment);
    const key: NewApiKey = {
      id: minted.publicId, serviceAccountId, environment: context.environment, displayPrefix: minted.displayPrefix, verifier: minted.verifier, scopes,
      expiresAt: input.expiresAt ?? null, allowedCidrs: cidrs, rateLimitPerMinute: input.rateLimitPerMinute ?? null, createdBy: context.actor.id, createdAt: context.now, rotatedFrom: null,
      name, idempotencyKey: input.idempotencyKey ?? null,
    };
    await this.repository.insertApiKey(key, mutation(context, { name: "access.api_key.minted", targetType: "api_key", targetId: key.id, summary: { serviceAccountId, displayPrefix: key.displayPrefix, name, scopes, environment: key.environment, expiresAt: key.expiresAt?.toISOString() ?? null } }));
    return { key: metadata(key), token: minted.token };
  }

  /** Mints a replacement with the same scopes; the previous key keeps working for a bounded overlap. */
  async rotateKey(context: OperationContext, keyId: string, overlapHours: number, maxActiveKeys: number | null): Promise<MintedKey & { previous: { id: string; expiresAt: Date } }> {
    const previous = await this.repository.getApiKey(keyId);
    if (!previous || previous.revokedAt) throw new AccessDomainError("not_found", "API key not found");
    if (previous.rotatedTo) throw new AccessDomainError("conflict", "This API key has already been rotated");
    if (previous.expiresAt && previous.expiresAt <= context.now) throw invalid("Expired keys cannot be rotated; mint a new key");
    const account = await this.required(previous.serviceAccountId);
    if (account.status !== "active") throw invalid("Suspended service accounts cannot receive new keys");
    const problems = validateApiKeyScopes(this.roles.access.permissions, previous.scopes, (await this.roles.catalog()).resolve(account.applicationRoles).permissions);
    if (problems.length) throw invalid(`The existing scopes no longer fit the service account: ${problems.join("; ")}`);
    await this.requireCapacity(context, maxActiveKeys, 1);
    let previousExpiresAt: Date;
    try { previousExpiresAt = rotationExpiry(context.now, overlapHours, previous.expiresAt); } catch (error) { throw invalid(error instanceof Error ? error.message : String(error)); }
    const minted = await mintApiKey(context.environment);
    const replacement: NewApiKey = {
      id: minted.publicId, serviceAccountId: previous.serviceAccountId, environment: context.environment, displayPrefix: minted.displayPrefix, verifier: minted.verifier, scopes: previous.scopes,
      expiresAt: previous.expiresAt, allowedCidrs: previous.allowedCidrs, rateLimitPerMinute: previous.rateLimitPerMinute, createdBy: context.actor.id, createdAt: context.now, rotatedFrom: previous.id,
    };
    await this.repository.rotateApiKey(previous.id, previousExpiresAt, replacement, mutation(context, { name: "access.api_key.rotated", targetType: "api_key", targetId: previous.id, summary: { replacement: replacement.id, previousExpiresAt: previousExpiresAt.toISOString() } }));
    return { key: metadata(replacement), token: minted.token, previous: { id: previous.id, expiresAt: previousExpiresAt } };
  }

  /**
   * Widening (or otherwise changing) scopes never mutates an active key: a
   * replacement is issued with the new scopes, and the previous key keeps
   * working only for a bounded overlap.
   */
  async replaceKey(context: OperationContext, keyId: string, input: { scopes: readonly string[]; overlapHours: number; actorAuthority?: ReadonlySet<string> }, maxActiveKeys: number | null): Promise<MintedKey & { previous: { id: string; expiresAt: Date } }> {
    const previous = await this.repository.getApiKey(keyId);
    if (!previous || previous.revokedAt) throw new AccessDomainError("not_found", "API key not found");
    if (previous.rotatedTo) throw new AccessDomainError("conflict", "This API key has already been rotated or replaced");
    const account = await this.required(previous.serviceAccountId);
    if (account.status !== "active") throw invalid("Suspended service accounts cannot receive new keys");
    const scopes = [...new Set(input.scopes)].sort();
    const problems = validateApiKeyScopes(this.roles.access.permissions, scopes, (await this.roles.catalog()).resolve(account.applicationRoles).permissions);
    const beyondActor = input.actorAuthority ? scopes.filter((scope) => !input.actorAuthority!.has(scope)) : [];
    if (beyondActor.length) problems.push(`You cannot grant scopes you do not hold: ${beyondActor.join(", ")}`);
    if (problems.length) throw invalid(problems.join("; "));
    await this.requireCapacity(context, maxActiveKeys, 1);
    let previousExpiresAt: Date;
    try { previousExpiresAt = rotationExpiry(context.now, input.overlapHours, previous.expiresAt); } catch (error) { throw invalid(error instanceof Error ? error.message : String(error)); }
    const minted = await mintApiKey(context.environment);
    const replacement: NewApiKey = {
      id: minted.publicId, serviceAccountId: previous.serviceAccountId, environment: context.environment, displayPrefix: minted.displayPrefix, verifier: minted.verifier, scopes,
      expiresAt: previous.expiresAt, allowedCidrs: previous.allowedCidrs, rateLimitPerMinute: previous.rateLimitPerMinute, createdBy: context.actor.id, createdAt: context.now, rotatedFrom: previous.id, name: previous.name ?? null,
    };
    await this.repository.rotateApiKey(previous.id, previousExpiresAt, replacement, mutation(context, { name: "access.api_key.replaced", targetType: "api_key", targetId: previous.id, summary: { replacement: replacement.id, before: previous.scopes, after: scopes, previousExpiresAt: previousExpiresAt.toISOString() } }), true);
    return { key: metadata(replacement), token: minted.token, previous: { id: previous.id, expiresAt: previousExpiresAt } };
  }

  async revokeKey(context: OperationContext, keyId: string, reason: string): Promise<void> {
    if (!reason.trim()) throw invalid("Revoking an API key requires a reason");
    const key = await this.repository.getApiKey(keyId);
    if (!key) throw new AccessDomainError("not_found", "API key not found");
    if (key.revokedAt) return;
    await this.repository.revokeApiKey(keyId, reason.trim(), mutation(context, { name: "access.api_key.revoked", targetType: "api_key", targetId: keyId, reason: reason.trim(), summary: { displayPrefix: key.displayPrefix } }));
  }

  private async required(id: string): Promise<ServiceAccountRecord> {
    const account = await this.repository.getServiceAccount(id);
    if (!account || account.deletedAt) throw new AccessDomainError("not_found", "Service account not found");
    return account;
  }

  private async requireCapacity(context: OperationContext, maxActiveKeys: number | null, rotating = 0): Promise<void> {
    if (maxActiveKeys === null) return;
    const active = (await this.repository.listApiKeys()).filter((key) => !key.revokedAt && (!key.expiresAt || key.expiresAt > context.now)).length;
    if (active - rotating >= maxActiveKeys) throw new AccessDomainError("limit_exceeded", `Your plan allows ${maxActiveKeys} active API keys`);
  }
}

function metadata(key: NewApiKey): ApiKeyMetadata {
  const { verifier: _verifier, idempotencyKey: _idempotencyKey, ...rest } = key;
  return { ...rest, lastUsedAt: null, rotatedTo: null, revokedAt: null, replacedBy: null };
}
