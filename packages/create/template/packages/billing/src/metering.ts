import { applicationConnectionString, createSqlRunner, tenantConnectionString, type DatabaseDriver, type SqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";
import { LagoMeteringProvider, OpenMeterProvider, usageDrift, type MeteringProvider, type ProviderUsage, type UsageDrift, type UsageEvent, type UsagePeriodQuery } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { sql } from "drizzle-orm";

import { meterMappings } from "./catalog.js";

export type MeteringEnvironment = Readonly<{ DATABASE_URL: string; DATABASE_DRIVER?: DatabaseDriver; OPENMETER_API_KEY?: string; OPENMETER_URL?: string; LAGO_API_KEY?: string; LAGO_API_URL?: string }>;

/** The declared metering provider, or native when its credential is absent (capability status reports why). */
export function meteringProvider(kind: "native" | "openmeter" | "lago", environment: MeteringEnvironment): MeteringProvider {
  if (kind === "openmeter" && environment.OPENMETER_API_KEY) return new OpenMeterProvider({ apiKey: environment.OPENMETER_API_KEY, mappings: meterMappings, ...(environment.OPENMETER_URL ? { baseUrl: environment.OPENMETER_URL } : {}) });
  if (kind === "lago" && environment.LAGO_API_KEY) return new LagoMeteringProvider({ apiKey: environment.LAGO_API_KEY, mappings: meterMappings, ...(environment.LAGO_API_URL ? { baseUrl: environment.LAGO_API_URL } : {}) });
  return new NativeMeteringProvider(environment.DATABASE_URL, environment.DATABASE_DRIVER);
}

const date = (value: unknown): Date => value instanceof Date ? value : new Date(String(value));

/** The zero-account default: usage_aggregate is the meter, so there is nothing to forward. */
export class NativeMeteringProvider implements MeteringProvider {
  readonly kind = "native" as const;
  constructor(private readonly databaseUrl: string, private readonly driver?: DatabaseDriver) {}

  async ingest(_events: readonly UsageEvent[]): Promise<void> { /* the local projection already counted it */ }

  async usage(query: UsagePeriodQuery, now: Date): Promise<ProviderUsage | null> {
    const tenant = createSqlRunner(tenantConnectionString(this.databaseUrl, query.organizationId), this.driver);
    const [row] = await tenant.query(sql`select quantity from usage_aggregate where organization_id = ${query.organizationId} and feature_code = ${query.featureCode} and period_start = ${query.start}`);
    return { provider: "native", organizationId: query.organizationId, featureCode: query.featureCode, periodStart: query.start, periodEnd: query.end, quantity: Number(row?.quantity ?? 0), balance: null, hasAccess: null, observedAt: now };
  }
}

/**
 * The idempotency key for one report: the same unreported range always
 * produces the same event ID, so a retry after a partial failure is
 * deduplicated by the provider.
 */
export function usageReportId(organizationId: string, featureCode: string, periodStart: Date, from: number, to: number): string {
  return `usage:${organizationId}:${featureCode}:${periodStart.toISOString()}:${from}-${to}`;
}

export type MeteringRunResult = Readonly<{ reported: number; reconciled: number; failed: number }>;

/**
 * Forwards committed usage to the metering provider and records what it
 * accepted, then reads the provider's own figures back for reconciliation.
 * Request paths never call this; the outbox runner does, after commit.
 */
export class UsageReporter {
  private readonly application: SqlRunner;
  constructor(private readonly databaseUrl: string, private readonly driver: DatabaseDriver | undefined, private readonly provider: MeteringProvider) {
    this.application = createSqlRunner(applicationConnectionString(databaseUrl), driver);
  }

  private tenant(organizationId: string): SqlRunner {
    return createSqlRunner(tenantConnectionString(this.databaseUrl, organizationId), this.driver);
  }

  async report(limit = 100): Promise<{ reported: number; failed: number }> {
    if (this.provider.kind === "native") return { reported: 0, failed: 0 };
    let reported = 0;
    let failed = 0;
    for (const row of await this.application.query(sql`select * from trestle_due_usage_reports(${limit})`)) {
      const organizationId = String(row.organization_id);
      const featureCode = String(row.feature_code);
      const periodStart = date(row.period_start);
      const from = Number(row.reported_quantity);
      const to = Number(row.quantity);
      const event: UsageEvent = { id: usageReportId(organizationId, featureCode, periodStart, from, to), organizationId, featureCode, quantity: to - from, occurredAt: periodStart };
      try {
        await this.provider.ingest([event]);
        // Only advance what was actually accepted; concurrent increments stay due.
        await this.tenant(organizationId).query(sql`update usage_aggregate set reported_quantity = greatest(reported_quantity, ${to})
          where organization_id = ${organizationId} and feature_code = ${featureCode} and period_start = ${periodStart}`);
        reported += 1;
      } catch {
        failed += 1;
      }
    }
    return { reported, failed };
  }

  async reconcile(now: Date, limit = 100): Promise<{ reconciled: number; failed: number }> {
    if (this.provider.kind === "native") return { reconciled: 0, failed: 0 };
    let reconciled = 0;
    let failed = 0;
    for (const row of await this.application.query(sql`select * from trestle_current_usage_periods(${limit})`)) {
      const query = { organizationId: String(row.organization_id), featureCode: String(row.feature_code), start: date(row.period_start), end: date(row.period_end) };
      try {
        const usage = await this.provider.usage(query, now);
        if (!usage) continue;
        await this.tenant(query.organizationId).query(sql`update usage_aggregate set provider = ${usage.provider}, provider_quantity = ${usage.quantity}, provider_balance = ${usage.balance},
          provider_has_access = ${usage.hasAccess}, provider_observed_at = ${usage.observedAt}
          where organization_id = ${query.organizationId} and feature_code = ${query.featureCode} and period_start = ${query.start}`);
        reconciled += 1;
      } catch {
        failed += 1;
      }
    }
    return { reconciled, failed };
  }
}

export type UsageProvenance = Readonly<{
  featureCode: string;
  periodStart: Date;
  periodEnd: Date;
  local: number;
  reported: number;
  provider: string | null;
  providerObservedAt: Date | null;
  providerBalance: number | null;
  providerHasAccess: boolean | null;
  drift: UsageDrift | null;
}>;

/** Where the figure an application sees came from, and how it compares with the provider. */
export function usageProvenance(row: Readonly<Record<string, unknown>>): UsageProvenance {
  const local = Number(row.quantity ?? 0);
  const providerQuantity = row.provider_quantity === null || row.provider_quantity === undefined ? null : Number(row.provider_quantity);
  return {
    featureCode: String(row.feature_code), periodStart: date(row.period_start), periodEnd: date(row.period_end), local, reported: Number(row.reported_quantity ?? 0),
    provider: row.provider ? String(row.provider) : null,
    providerObservedAt: row.provider_observed_at ? date(row.provider_observed_at) : null,
    providerBalance: row.provider_balance === null || row.provider_balance === undefined ? null : Number(row.provider_balance),
    providerHasAccess: typeof row.provider_has_access === "boolean" ? row.provider_has_access : null,
    drift: providerQuantity === null ? null : usageDrift(String(row.feature_code), local, providerQuantity),
  };
}
