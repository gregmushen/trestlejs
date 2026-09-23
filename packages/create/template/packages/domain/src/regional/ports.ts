import type { Mutation } from "../access/ports.js";

/** Organization regional defaults as stored; null inherits the application default. */
export type OrganizationRegionalRecord = Readonly<{ language: string | null; locale: string | null; timeZone: string | null; currency: string | null }>;
/** A user's own preferences; null inherits the organization, then the application. */
export type UserRegionalRecord = Readonly<{ language: string | null; locale: string | null; timeZone: string | null }>;

export const emptyOrganizationRegional: OrganizationRegionalRecord = { language: null, locale: null, timeZone: null, currency: null };
export const emptyUserRegional: UserRegionalRecord = { language: null, locale: null, timeZone: null };

/** Tenant-bound persistence for regional settings. Writes commit with their audit record and event. */
export interface RegionalRepository {
  organizationSettings(): Promise<OrganizationRegionalRecord | null>;
  saveOrganizationSettings(values: OrganizationRegionalRecord, mutation: Mutation): Promise<void>;
  userPreference(userId: string): Promise<UserRegionalRecord | null>;
  saveUserPreference(userId: string, values: UserRegionalRecord, mutation: Mutation): Promise<void>;
}
