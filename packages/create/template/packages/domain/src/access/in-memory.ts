import type { ApiKeyMetadata, ApplicationRoleAssignment, ApplicationRoleRecord, AuditEntry, Member, Mutation, NewApiKey, ScopeProfile, ServiceAccountRecord, TenantAccessRepository } from "./ports.js";

/** Deterministic tenant repository for tests and local tooling. Stores verifiers only. */
export class InMemoryTenantAccessRepository implements TenantAccessRepository {
  readonly members: Member[] = [];
  readonly roles = new Map<string, ApplicationRoleRecord>();
  readonly assignments: Array<ApplicationRoleAssignment & { revokedAt?: Date }> = [];
  readonly accounts = new Map<string, ServiceAccountRecord>();
  readonly keys = new Map<string, ApiKeyMetadata & { verifier: string; idempotencyKey?: string | null }>();
  readonly profiles = new Map<string, ScopeProfile>();
  readonly mutations: Mutation[] = [];

  private record(mutation: Mutation): void { this.mutations.push(mutation); }
  async listMembers() { return [...this.members]; }
  async setMemberOrganizationRoles(memberId: string, roles: readonly string[], mutation: Mutation) {
    const index = this.members.findIndex((member) => member.memberId === memberId);
    this.members[index] = { ...this.members[index]!, organizationRoles: [...roles] };
    this.record(mutation);
  }
  async listApplicationRoles() { return [...this.roles.values()]; }
  async saveApplicationRole(role: ApplicationRoleRecord, mutation: Mutation) { this.roles.set(role.key, role); this.record(mutation); }
  async deleteApplicationRole(key: string, mutation: Mutation) {
    this.roles.delete(key);
    for (const assignment of this.assignments) if (assignment.role === key && !assignment.revokedAt) assignment.revokedAt = mutation.context.now;
    this.record(mutation);
  }
  async listApplicationRoleAssignments(userId?: string) { return this.assignments.filter((assignment) => !assignment.revokedAt && (!userId || assignment.userId === userId)).map(({ revokedAt: _revokedAt, ...assignment }) => assignment); }
  async setUserApplicationRoles(userId: string, roles: readonly string[], mutation: Mutation) {
    for (const assignment of this.assignments) if (assignment.userId === userId && !assignment.revokedAt && !roles.includes(assignment.role)) assignment.revokedAt = mutation.context.now;
    const current = new Set(this.assignments.filter((assignment) => assignment.userId === userId && !assignment.revokedAt).map((assignment) => assignment.role));
    for (const role of roles) if (!current.has(role)) this.assignments.push({ userId, role, grantedBy: mutation.context.actor.id, grantedAt: mutation.context.now });
    this.record(mutation);
  }
  async listServiceAccounts() { return [...this.accounts.values()]; }
  async getServiceAccount(id: string) { return this.accounts.get(id) ?? null; }
  async createServiceAccount(account: ServiceAccountRecord, mutation: Mutation) { this.accounts.set(account.id, account); this.record(mutation); }
  async setServiceAccountStatus(id: string, status: "active" | "suspended", _reason: string | null, mutation: Mutation) { this.accounts.set(id, { ...this.accounts.get(id)!, status }); this.record(mutation); }
  async updateServiceAccount(id: string, changes: Readonly<{ name: string; description: string }>, mutation: Mutation) { this.accounts.set(id, { ...this.accounts.get(id)!, ...changes }); this.record(mutation); }
  async deleteServiceAccount(id: string, reason: string, mutation: Mutation) {
    for (const [keyId, key] of this.keys) if (key.serviceAccountId === id && !key.revokedAt) this.keys.set(keyId, { ...key, revokedAt: mutation.context.now, revocationReason: `service account deleted: ${reason}` });
    this.accounts.set(id, { ...this.accounts.get(id)!, status: "suspended", deletedAt: mutation.context.now });
    this.record(mutation);
  }
  async findApiKeyByIdempotencyKey(idempotencyKey: string) { const key = [...this.keys.values()].find((candidate) => candidate.idempotencyKey === idempotencyKey); if (!key) return null; const { verifier: _verifier, idempotencyKey: _key, ...metadata } = key; return metadata; }
  async setServiceAccountRoles(id: string, roles: readonly string[], mutation: Mutation) { this.accounts.set(id, { ...this.accounts.get(id)!, applicationRoles: [...roles] }); this.record(mutation); }
  async listApiKeys(serviceAccountId?: string) { return [...this.keys.values()].filter((key) => !serviceAccountId || key.serviceAccountId === serviceAccountId).map(({ verifier: _verifier, ...key }) => key); }
  async getApiKey(id: string) { const key = this.keys.get(id); if (!key) return null; const { verifier: _verifier, ...metadata } = key; return metadata; }
  async insertApiKey(key: NewApiKey, mutation: Mutation) { this.keys.set(key.id, { ...key, lastUsedAt: null, rotatedTo: null, revokedAt: null }); this.record(mutation); }
  async rotateApiKey(previousId: string, previousExpiresAt: Date, replacement: NewApiKey, mutation: Mutation, replaced = false) {
    this.keys.set(previousId, { ...this.keys.get(previousId)!, expiresAt: previousExpiresAt, rotatedTo: replacement.id, replacedBy: replaced ? replacement.id : null });
    this.keys.set(replacement.id, { ...replacement, lastUsedAt: null, rotatedTo: null, revokedAt: null });
    this.record(mutation);
  }
  async revokeApiKey(id: string, reason: string, mutation: Mutation) { this.keys.set(id, { ...this.keys.get(id)!, revokedAt: mutation.context.now, revocationReason: reason }); this.record(mutation); }
  async apiKeyUsage() { return []; }
  async listScopeProfiles() { return [...this.profiles.values()]; }
  async createScopeProfile(profile: ScopeProfile, mutation: Mutation) { this.profiles.set(profile.id, profile); this.record(mutation); }
  async deleteScopeProfile(id: string, mutation: Mutation) { this.profiles.delete(id); this.record(mutation); }
  async listAudit(limit: number): Promise<AuditEntry[]> {
    return this.mutations.slice(-limit).reverse().map((mutation, index) => ({ id: String(index), occurredAt: mutation.context.now, name: mutation.audit.name, actorType: mutation.context.actor.type, actorId: mutation.context.actor.id, targetType: mutation.audit.targetType, targetId: mutation.audit.targetId, reason: mutation.audit.reason ?? null, outcome: mutation.audit.outcome, correlationId: mutation.context.correlationId }));
  }
}
