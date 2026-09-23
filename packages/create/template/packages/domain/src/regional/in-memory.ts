import type { Mutation } from "../access/ports.js";
import type { OrganizationRegionalRecord, RegionalRepository, UserRegionalRecord } from "./ports.js";

/** Deterministic repository for tests; records mutations instead of auditing them. */
export class InMemoryRegionalRepository implements RegionalRepository {
  organization: OrganizationRegionalRecord | null = null;
  readonly users = new Map<string, UserRegionalRecord>();
  readonly mutations: Mutation[] = [];

  async organizationSettings(): Promise<OrganizationRegionalRecord | null> { return this.organization; }
  async saveOrganizationSettings(values: OrganizationRegionalRecord, mutation: Mutation): Promise<void> { this.organization = values; this.mutations.push(mutation); }
  async userPreference(userId: string): Promise<UserRegionalRecord | null> { return this.users.get(userId) ?? null; }
  async saveUserPreference(userId: string, values: UserRegionalRecord, mutation: Mutation): Promise<void> { this.users.set(userId, values); this.mutations.push(mutation); }
}
