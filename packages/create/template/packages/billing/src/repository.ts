import { createSqlRunner, tenantConnectionString, type DatabaseDriver, type SqlRow, type SqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";
import type { BillingProjectionRepository, SubscriptionSummary } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { sql } from "drizzle-orm";

import { features } from "./catalog.js";
import { resolveEffectiveEntitlements, type EffectiveEntitlement, type SubscriptionOverride } from "./effective.js";
import type { FeatureCatalog } from "./features.js";
import { parsePlanVersionRef, planVersionRef, type PlanVersion } from "./plans.js";
import type { ScheduledPlanChange } from "./transparency.js";
import { periodBounds } from "./usage.js";

const date = (value: unknown): Date | undefined => value === null || value === undefined ? undefined : value instanceof Date ? value : new Date(String(value));
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

export function planVersionFromRow(row: SqlRow): PlanVersion {
  return {
    plan: String(row.plan), version: Number(row.version), name: String(row.name), state: String(row.state) as PlanVersion["state"],
    entitlements: json<PlanVersion["entitlements"]>(row.entitlements ?? {}),
    ...(row.activated_at ? { activatedAt: date(row.activated_at)! } : {}),
    ...(row.grandfathered_at ? { grandfatheredAt: date(row.grandfathered_at)! } : {}),
    ...(row.retired_at ? { retiredAt: date(row.retired_at)! } : {}),
  };
}

export function overrideFromRow(row: SqlRow): SubscriptionOverride {
  return {
    id: String(row.id), organizationId: String(row.organization_id), code: String(row.code), enabled: row.enabled !== false, values: json<SubscriptionOverride["values"]>(row.values ?? {}),
    reason: String(row.reason), author: String(row.author), effectiveAt: date(row.effective_at)!, expiresAt: date(row.expires_at) ?? null, removedAt: date(row.removed_at) ?? null,
  };
}

/**
 * Tenant-bound commercial reads: the recorded plan version, overrides,
 * scheduled changes, and usage. Every query runs under forced RLS.
 */
export class PostgresCommercialRepository {
  private readonly tenant: SqlRunner;
  constructor(databaseUrl: string, driver: DatabaseDriver | undefined, private readonly organizationId: string, private readonly catalog: FeatureCatalog = features) {
    this.tenant = createSqlRunner(tenantConnectionString(databaseUrl, organizationId), driver);
  }

  async subscription(): Promise<{ summary: SubscriptionSummary | null; planVersion: PlanVersion | null; startedAt?: Date }> {
    const [row] = await this.tenant.query(sql`select * from organization_subscription where organization_id = ${this.organizationId}`);
    if (!row) return { summary: null, planVersion: null };
    const ref = parsePlanVersionRef(String(row.plan_version ?? `${String(row.plan)}@1`));
    const [version] = ref ? await this.tenant.query(sql`select * from plan_version where plan = ${ref.plan} and version = ${ref.version}`) : [];
    const entitlements = await this.tenant.query(sql`select entitlement from organization_entitlement where organization_id = ${this.organizationId} and enabled`);
    const summary: SubscriptionSummary = {
      organizationId: this.organizationId, provider: String(row.provider), plan: String(row.plan), status: String(row.status) as SubscriptionSummary["status"], cancelAtPeriodEnd: row.cancel_at_period_end === true,
      ...(row.provider_customer_id ? { providerCustomerId: String(row.provider_customer_id) } : {}),
      ...(row.provider_subscription_id ? { providerSubscriptionId: String(row.provider_subscription_id) } : {}),
      ...(row.current_period_start ? { currentPeriodStart: date(row.current_period_start)! } : {}),
      ...(row.current_period_end ? { currentPeriodEnd: date(row.current_period_end)! } : {}),
      entitlements: entitlements.map((entry) => String(entry.entitlement)).sort(),
    };
    return { summary, planVersion: version ? planVersionFromRow(version) : null, ...(row.started_at ? { startedAt: date(row.started_at)! } : {}) };
  }

  async overrides(): Promise<SubscriptionOverride[]> {
    return (await this.tenant.query(sql`select * from subscription_override where organization_id = ${this.organizationId} order by effective_at`)).map(overrideFromRow);
  }

  async scheduledChanges(): Promise<ScheduledPlanChange[]> {
    return (await this.tenant.query(sql`select * from subscription_change where organization_id = ${this.organizationId} and applied_at is null and cancelled_at is null order by effective_at`))
      .map((row) => ({ id: String(row.id), organizationId: this.organizationId, toPlanVersion: String(row.to_plan_version), effectiveAt: date(row.effective_at)!, appliedAt: null, cancelledAt: null }));
  }

  async activePlanVersions(): Promise<PlanVersion[]> {
    return (await this.tenant.query(sql`select * from plan_version where state = 'active' order by plan, version`)).map(planVersionFromRow);
  }

  async usage(code: string, now: Date): Promise<{ used: number; period: { start: Date; end: Date } } | null> {
    const feature = this.catalog.get(code);
    if (!feature?.metered) return null;
    const period = periodBounds(feature.metered.period, now);
    const [row] = await this.tenant.query(sql`select quantity from usage_aggregate where organization_id = ${this.organizationId} and feature_code = ${code} and period_start = ${period.start}`);
    return { used: Number(row?.quantity ?? 0), period };
  }

  /** Usage ingestion is separate from authorization; callers evaluate quotas before incrementing. */
  async incrementUsage(code: string, quantity: number, now: Date): Promise<void> {
    const feature = this.catalog.get(code);
    if (!feature?.metered) throw new Error(`${code} is not a metered feature`);
    const period = periodBounds(feature.metered.period, now);
    await this.tenant.query(sql`insert into usage_aggregate (organization_id, feature_code, period_start, period_end, quantity) values (${this.organizationId}, ${code}, ${period.start}, ${period.end}, ${quantity})
      on conflict (organization_id, feature_code, period_start) do update set quantity = usage_aggregate.quantity + excluded.quantity`);
  }
}

/**
 * Writes the provider-neutral subscription projection and recomputes the
 * effective-entitlement projection from the recorded plan version and this
 * subscription's overrides, in one transaction under forced RLS.
 */
export class PostgresBillingProjectionRepository implements BillingProjectionRepository {
  constructor(private readonly databaseUrl: string, private readonly driver?: DatabaseDriver, private readonly catalog: FeatureCatalog = features, private readonly clock: () => Date = () => new Date()) {}

  async get(organizationId: string): Promise<SubscriptionSummary | null> {
    return (await new PostgresCommercialRepository(this.databaseUrl, this.driver, organizationId, this.catalog).subscription()).summary;
  }

  async put(value: SubscriptionSummary): Promise<void> {
    const tenant = createSqlRunner(tenantConnectionString(this.databaseUrl, value.organizationId), this.driver);
    const [current] = await tenant.query(sql`select plan, plan_version, started_at from organization_subscription where organization_id = ${value.organizationId}`);
    // A provider price mapped to a specific version is authoritative; otherwise keep the current version, else the active one.
    const mappedRef = value.lines?.map((line) => line.planVersion).find((ref): ref is string => Boolean(ref) && parsePlanVersionRef(ref!)?.plan === value.plan);
    const keep = mappedRef ? parsePlanVersionRef(mappedRef) : current && String(current.plan) === value.plan && current.plan_version ? parsePlanVersionRef(String(current.plan_version)) : null;
    const [versionRow] = keep
      ? await tenant.query(sql`select * from plan_version where plan = ${keep.plan} and version = ${keep.version}`)
      : await tenant.query(sql`select * from plan_version where plan = ${value.plan} and state = 'active' order by version desc limit 1`);
    const planVersion = versionRow ? planVersionFromRow(versionRow) : null;
    const startedAt = date(current?.started_at) ?? value.currentPeriodStart ?? this.clock();
    const overrides = (await tenant.query(sql`select * from subscription_override where organization_id = ${value.organizationId}`)).map(overrideFromRow);
    const effective = resolveEffectiveEntitlements(this.catalog, { status: value.status, planVersion, startedAt }, overrides, this.clock());
    await tenant.atomic([
      sql`insert into organization_subscription (organization_id, provider, provider_customer_id, provider_subscription_id, plan, plan_version, status, started_at, current_period_start, current_period_end, cancel_at_period_end, updated_at)
          values (${value.organizationId}, ${value.provider}, ${value.providerCustomerId ?? null}, ${value.providerSubscriptionId ?? null}, ${value.plan}, ${planVersion ? planVersionRef(planVersion) : null}, ${value.status}, ${startedAt}, ${value.currentPeriodStart ?? null}, ${value.currentPeriodEnd ?? null}, ${value.cancelAtPeriodEnd}, now())
          on conflict (organization_id) do update set provider = excluded.provider, provider_customer_id = excluded.provider_customer_id, provider_subscription_id = excluded.provider_subscription_id, plan = excluded.plan, plan_version = excluded.plan_version,
            status = excluded.status, current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end, updated_at = now()`,
      ...effectiveEntitlementStatements(value.organizationId, effective),
      ...(value.lines ? [
        sql`delete from subscription_line where organization_id = ${value.organizationId}`,
        ...value.lines.map((line) => sql`insert into subscription_line (organization_id, plan_version, offer, quantity, provider_item_id, provider_price_id)
          values (${value.organizationId}, ${line.planVersion ?? `unmapped:${line.providerPriceId}`}, ${line.offer}, ${line.quantity}, ${line.providerItemId}, ${line.providerPriceId})`),
      ] : []),
    ]);
  }
}

export function effectiveEntitlementStatements(organizationId: string, effective: readonly EffectiveEntitlement[]) {
  return [
    sql`delete from organization_entitlement where organization_id = ${organizationId}`,
    ...effective.map((entry) => sql`insert into organization_entitlement (organization_id, entitlement, enabled, values, source, inherited_from, override_id, effective_at, expires_at, updated_at)
      values (${organizationId}, ${entry.code}, ${entry.enabled}, ${JSON.stringify(entry.values)}::text::jsonb, ${entry.source}, ${entry.inheritedFrom ?? null}, ${entry.overrideId ?? null}, ${entry.effectiveAt}, ${entry.expiresAt ?? null}, now())`),
  ];
}
