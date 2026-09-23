import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import type { ApiKeyRecord, CustomRoleInput } from "@__TRESTLE_PROJECT_NAME__/authz";
import type { EffectiveEntitlement } from "@__TRESTLE_PROJECT_NAME__/billing";
import { applicationConnectionString, createSqlRunner, tenantConnectionString } from "@__TRESTLE_PROJECT_NAME__/db";
import { sql } from "drizzle-orm";

export type ResolvedApiKey = ApiKeyRecord & Readonly<{
  verifier: string;
  serviceAccountStatus: "active" | "suspended";
  serviceAccountRoles: readonly string[];
  rateLimitPerMinute: number | null;
}>;

type Row = Record<string, unknown>;
const tenant = (environment: AuthEnvironment, organizationId: string) => createSqlRunner(tenantConnectionString(environment.DATABASE_URL, organizationId), environment.DATABASE_DRIVER);
const date = (value: unknown): Date | null => value === null || value === undefined ? null : value instanceof Date ? value : new Date(String(value));
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];

export const defaultAccessDependencies = {
  findMembership: async (userId: string, organizationId: string, environment: AuthEnvironment) => {
    const [record] = await createSqlRunner(environment.DATABASE_URL, environment.DATABASE_DRIVER).query(sql`select role from member where user_id = ${userId} and organization_id = ${organizationId} limit 1`);
    return record ? { role: String(record.role) } : null;
  },
  loadApplicationRoles: async (userId: string, organizationId: string, environment: AuthEnvironment): Promise<string[]> => {
    return (await tenant(environment, organizationId).query(sql`select role from application_role_assignment where organization_id = ${organizationId} and user_id = ${userId} and revoked_at is null order by role`)).map((row) => String(row.role));
  },
  loadCustomRoles: async (organizationId: string, environment: AuthEnvironment): Promise<CustomRoleInput[]> => {
    return (await tenant(environment, organizationId).query(sql`select key, name, description, permissions from application_role where organization_id = ${organizationId} order by key`)).map((row) => ({ key: String(row.key), name: String(row.name), description: String(row.description ?? ""), permissions: strings(row.permissions) }));
  },
  loadEntitlements: async (organizationId: string, environment: AuthEnvironment): Promise<EffectiveEntitlement[]> => {
    return (await tenant(environment, organizationId).query(sql`select entitlement, enabled, values, source, inherited_from, override_id, effective_at, expires_at from organization_entitlement where organization_id = ${organizationId} and (expires_at is null or expires_at > now())`)).map((row) => ({
      code: String(row.entitlement),
      enabled: row.enabled !== false,
      values: (row.values ?? {}) as EffectiveEntitlement["values"],
      source: row.source === "subscription_override" ? "subscription_override" : "plan",
      ...(row.inherited_from ? { inheritedFrom: String(row.inherited_from) } : {}),
      ...(row.override_id ? { overrideId: String(row.override_id) } : {}),
      effectiveAt: (date(row.effective_at) ?? new Date(0)).toISOString(),
      ...(row.expires_at ? { expiresAt: date(row.expires_at)!.toISOString() } : {}),
    }));
  },
  resolveApiKey: async (publicId: string, environment: AuthEnvironment): Promise<ResolvedApiKey | null> => {
    // Runs as the restricted application role, which may execute only this single-key resolver.
    const [row] = await createSqlRunner(applicationConnectionString(environment.DATABASE_URL), environment.DATABASE_DRIVER).query(sql`select * from trestle_resolve_api_key(${publicId})`);
    if (!row) return null;
    return {
      id: publicId,
      organizationId: String(row.organization_id),
      serviceAccountId: String(row.service_account_id),
      environment: String(row.environment) as ResolvedApiKey["environment"],
      scopes: strings(row.scopes),
      verifier: String(row.verifier),
      expiresAt: date(row.expires_at),
      revokedAt: date(row.revoked_at),
      allowedCidrs: row.allowed_cidrs ? strings(row.allowed_cidrs) : null,
      serviceAccountStatus: row.service_account_status === "active" ? "active" : "suspended",
      serviceAccountRoles: strings(row.service_account_roles),
      rateLimitPerMinute: typeof row.rate_limit_per_minute === "number" ? row.rate_limit_per_minute : null,
    };
  },
  /** Current-period consumption for a metered feature, read under forced RLS. */
  meteredUsage: async (organizationId: string, code: string, periodStart: Date, environment: AuthEnvironment): Promise<number> => {
    const [row] = await tenant(environment, organizationId).query(sql`select quantity from usage_aggregate where organization_id = ${organizationId} and feature_code = ${code} and period_start = ${periodStart}`);
    return Number(row?.quantity ?? 0);
  },
  recordApiKeyUse: async (key: ResolvedApiKey, outcome: "allowed" | "denied", environment: AuthEnvironment, metered?: { code: string; period: { start: Date; end: Date } }): Promise<void> => {
    await tenant(environment, key.organizationId).atomic([
      ...(outcome === "allowed" ? [sql`update api_key set last_used_at = now() where id = ${key.id} and organization_id = ${key.organizationId}`] : []),
      ...(outcome === "allowed" && metered ? [sql`insert into usage_aggregate (organization_id, feature_code, period_start, period_end, quantity) values (${key.organizationId}, ${metered.code}, ${metered.period.start}, ${metered.period.end}, 1)
        on conflict (organization_id, feature_code, period_start) do update set quantity = usage_aggregate.quantity + 1`] : []),
      sql`insert into api_key_usage (organization_id, api_key_id, day, requests, denied) values (${key.organizationId}, ${key.id}, current_date, ${outcome === "allowed" ? 1 : 0}, ${outcome === "denied" ? 1 : 0}) on conflict (api_key_id, day) do update set requests = api_key_usage.requests + excluded.requests, denied = api_key_usage.denied + excluded.denied`,
    ]);
  },
};
