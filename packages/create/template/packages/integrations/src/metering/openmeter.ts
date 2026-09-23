import { meterFor, MeteringProviderError, type MeteringProvider, type MeterMapping, type ProviderUsage, type UsageEvent, type UsagePeriodQuery } from "./types.js";

export type OpenMeterConfig = Readonly<{ apiKey: string; baseUrl?: string; mappings: readonly MeterMapping[]; fetcher?: (url: string, init: RequestInit) => Promise<Response>; timeoutMs?: number }>;

/**
 * OpenMeter over its HTTP API: usage is ingested as CloudEvents with the
 * Trestle organization as the subject, and read back per meter for
 * reconciliation. Only mapped features leave Trestle.
 */
export class OpenMeterProvider implements MeteringProvider {
  readonly kind = "openmeter" as const;
  private readonly base: string;
  private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  constructor(private readonly config: OpenMeterConfig) {
    this.base = (config.baseUrl ?? "https://openmeter.cloud").replace(/\/+$/u, "");
    this.fetcher = config.fetcher ?? ((url, init) => fetch(url, init));
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000), headers: { authorization: `Bearer ${this.config.apiKey}`, accept: "application/json", ...(init.headers as Record<string, string> | undefined) } });
    } catch {
      throw new MeteringProviderError("OpenMeter could not be reached", true);
    }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new MeteringProviderError(`OpenMeter responded ${response.status}`, response.status >= 500 || response.status === 429, response.status); }
    return response;
  }

  async ingest(events: readonly UsageEvent[]): Promise<void> {
    const cloudEvents = events.flatMap((event) => {
      const mapping = this.config.mappings.find((candidate) => candidate.featureCode === event.featureCode);
      return mapping ? [{ specversion: "1.0", id: event.id, source: "trestle", type: mapping.eventType ?? event.featureCode, subject: event.organizationId, time: event.occurredAt.toISOString(), data: { quantity: event.quantity } }] : [];
    });
    if (!cloudEvents.length) return;
    // OpenMeter deduplicates on (id, source), so a retried report is not counted twice.
    const response = await this.request("/api/v1/events", { method: "POST", headers: { "content-type": "application/cloudevents-batch+json" }, body: JSON.stringify(cloudEvents) });
    await response.body?.cancel().catch(() => undefined);
  }

  async usage(query: UsagePeriodQuery, now: Date): Promise<ProviderUsage | null> {
    const meter = meterFor(this.config.mappings, query.featureCode);
    if (!meter) return null;
    const params = new URLSearchParams({ from: query.start.toISOString(), to: query.end.toISOString(), subject: query.organizationId });
    const result = await (await this.request(`/api/v1/meters/${encodeURIComponent(meter)}/query?${params}`)).json() as { data?: Array<{ value?: number; subject?: string }> };
    const quantity = (result.data ?? []).filter((row) => !row.subject || row.subject === query.organizationId).reduce((total, row) => total + Number(row.value ?? 0), 0);
    const feature = this.config.mappings.find((mapping) => mapping.featureCode === query.featureCode)?.entitlementFeature;
    let balance: number | null = null;
    let hasAccess: boolean | null = null;
    if (feature) {
      const value = await (await this.request(`/api/v1/subjects/${encodeURIComponent(query.organizationId)}/entitlements/${encodeURIComponent(feature)}/value`)).json() as { hasAccess?: boolean; balance?: number };
      balance = typeof value.balance === "number" ? value.balance : null;
      hasAccess = typeof value.hasAccess === "boolean" ? value.hasAccess : null;
    }
    return { provider: "openmeter", organizationId: query.organizationId, featureCode: query.featureCode, periodStart: query.start, periodEnd: query.end, quantity, balance, hasAccess, observedAt: now };
  }
}
