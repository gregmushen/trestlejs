import { meterFor, MeteringProviderError, type MeteringProvider, type MeterMapping, type ProviderUsage, type UsageEvent, type UsagePeriodQuery } from "./types.js";

export type LagoMeteringConfig = Readonly<{ apiKey: string; baseUrl?: string; mappings: readonly MeterMapping[]; fetcher?: (url: string, init: RequestInit) => Promise<Response>; timeoutMs?: number }>;

/**
 * Lago usage-based billing: events carry the Trestle organization as both the
 * external customer and external subscription ID, and a billable metric code
 * per mapped feature. Lago rates the usage; Trestle keeps the projection.
 */
export class LagoMeteringProvider implements MeteringProvider {
  readonly kind = "lago" as const;
  private readonly base: string;
  private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  constructor(private readonly config: LagoMeteringConfig) {
    this.base = (config.baseUrl ?? "https://api.getlago.com").replace(/\/+$/u, "");
    this.fetcher = config.fetcher ?? ((url, init) => fetch(url, init));
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000), headers: { authorization: `Bearer ${this.config.apiKey}`, accept: "application/json", ...(init.headers as Record<string, string> | undefined) } });
    } catch {
      throw new MeteringProviderError("Lago could not be reached", true);
    }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new MeteringProviderError(`Lago responded ${response.status}`, response.status >= 500 || response.status === 429, response.status); }
    return response;
  }

  async ingest(events: readonly UsageEvent[]): Promise<void> {
    const batch = events.flatMap((event) => {
      const code = meterFor(this.config.mappings, event.featureCode);
      // Lago deduplicates on transaction_id.
      return code ? [{ transaction_id: event.id, external_subscription_id: event.organizationId, code, timestamp: Math.floor(event.occurredAt.getTime() / 1000), properties: { quantity: event.quantity } }] : [];
    });
    if (!batch.length) return;
    const response = await this.request("/api/v1/events/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: batch }) });
    await response.body?.cancel().catch(() => undefined);
  }

  async usage(query: UsagePeriodQuery, now: Date): Promise<ProviderUsage | null> {
    const code = meterFor(this.config.mappings, query.featureCode);
    if (!code) return null;
    const organization = encodeURIComponent(query.organizationId);
    let result: { customer_usage?: { charges_usage?: Array<{ units?: string | number; billable_metric?: { code?: string } }> } };
    try {
      result = await (await this.request(`/api/v1/customers/${organization}/current_usage?external_subscription_id=${organization}`)).json() as typeof result;
    } catch (error) {
      // No Lago subscription yet: nothing has been rated, which is a figure, not a failure.
      if (error instanceof MeteringProviderError && error.status === 404) result = {};
      else throw error;
    }
    const quantity = (result.customer_usage?.charges_usage ?? []).filter((charge) => charge.billable_metric?.code === code).reduce((total, charge) => total + Number(charge.units ?? 0), 0);
    return { provider: "lago", organizationId: query.organizationId, featureCode: query.featureCode, periodStart: query.start, periodEnd: query.end, quantity, balance: null, hasAccess: null, observedAt: now };
  }
}
