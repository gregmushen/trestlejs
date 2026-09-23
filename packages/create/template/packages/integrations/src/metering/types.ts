/**
 * Usage metering port. The provider meters, rates, and keeps balances; the
 * local usage projection is what request paths read. No authorization
 * decision ever waits on a metering provider.
 */

export type MeteringProviderKind = "native" | "openmeter" | "lago";

/** One usage fact, already counted in the local projection. `id` makes provider ingestion idempotent. */
export type UsageEvent = Readonly<{
  id: string;
  organizationId: string;
  featureCode: string;
  quantity: number;
  occurredAt: Date;
}>;

export type UsagePeriodQuery = Readonly<{ organizationId: string; featureCode: string; start: Date; end: Date }>;

/** What the provider reports for one feature and period; figures only, never credentials or raw bodies. */
export type ProviderUsage = Readonly<{
  provider: MeteringProviderKind;
  organizationId: string;
  featureCode: string;
  periodStart: Date;
  periodEnd: Date;
  quantity: number;
  /** Remaining balance or credit when the provider grants one; null when unlimited or unknown. */
  balance: number | null;
  /** The provider's own access verdict (for example exhausted credits); informational. */
  hasAccess: boolean | null;
  observedAt: Date;
}>;

/**
 * One stable Trestle feature code maps to exactly one provider meter or
 * billable metric. Unmapped features stay native.
 */
export type MeterMapping = Readonly<{
  featureCode: string;
  /** OpenMeter meter slug, or Lago billable metric code. */
  meter: string;
  /** OpenMeter CloudEvents `type` the meter aggregates; defaults to the feature code. */
  eventType?: string;
  /** OpenMeter feature key whose entitlement value supplies balance and access. */
  entitlementFeature?: string;
}>;

export interface MeteringProvider {
  readonly kind: MeteringProviderKind;
  /** Forwards committed usage; safe to retry with the same event IDs. */
  ingest(events: readonly UsageEvent[]): Promise<void>;
  /** Reads provider-side usage for reconciliation; null when the feature is not mapped. */
  usage(query: UsagePeriodQuery, now: Date): Promise<ProviderUsage | null>;
}

export class MeteringProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "MeteringProviderError";
  }
}

/** Compares the local projection with the provider's figure; the explanation is shown to operators. */
export type UsageDrift = Readonly<{ featureCode: string; local: number; provider: number; difference: number; outcome: "in_sync" | "provider_behind" | "provider_ahead" }>;

export function usageDrift(featureCode: string, local: number, provider: number): UsageDrift {
  const difference = provider - local;
  return { featureCode, local, provider, difference, outcome: difference === 0 ? "in_sync" : difference < 0 ? "provider_behind" : "provider_ahead" };
}

export function meterFor(mappings: readonly MeterMapping[], featureCode: string): string | null {
  return mappings.find((mapping) => mapping.featureCode === featureCode)?.meter ?? null;
}

/** Validates a mapping set: each feature and each meter appears once. */
export function validateMeterMappings(mappings: readonly MeterMapping[], meteredFeatures: readonly string[]): string[] {
  const problems: string[] = [];
  const features = new Set<string>();
  const meters = new Set<string>();
  for (const mapping of mappings) {
    if (!meteredFeatures.includes(mapping.featureCode)) problems.push(`${mapping.featureCode} is not a metered feature`);
    if (features.has(mapping.featureCode)) problems.push(`${mapping.featureCode} is mapped more than once`);
    if (meters.has(mapping.meter)) problems.push(`meter ${mapping.meter} is mapped to more than one feature`);
    features.add(mapping.featureCode);
    meters.add(mapping.meter);
  }
  return problems;
}
