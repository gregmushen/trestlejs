export type StripeCatalog = Readonly<{ schemaVersion: 1; currency: string; plans: Readonly<Record<string, Readonly<{ version: number; name: string; unitAmount: number; interval: "month" | "year" }>>> }>;
export type StripeSyncItem = Readonly<{ plan: string; lookupKey: string; classification: "already_correct" | "create" | "blocked"; priceId?: string; reason?: string }>;
export type StripeSyncReport = Readonly<{ items: StripeSyncItem[]; prices: Record<string, string> }>;

type Fetch = typeof fetch;

async function stripeRequest<T>(secretKey: string, pathname: string, init: RequestInit = {}, request: Fetch = fetch): Promise<T> {
  const response = await request(`https://api.stripe.com${pathname}`, { ...init, headers: { authorization: `Bearer ${secretKey}`, ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } });
  if (!response.ok) throw new Error(`Stripe API returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export function validateStripeCatalog(value: unknown): StripeCatalog {
  const catalog = value as Partial<StripeCatalog>;
  if (catalog.schemaVersion !== 1 || !catalog.currency || !catalog.plans || typeof catalog.plans !== "object") throw new Error("invalid Stripe catalog");
  for (const [plan, item] of Object.entries(catalog.plans)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(plan) || !Number.isInteger(item.version) || item.version < 1 || !Number.isInteger(item.unitAmount) || item.unitAmount < 0 || !["month", "year"].includes(item.interval)) throw new Error(`invalid Stripe catalog plan ${plan}`);
  }
  return catalog as StripeCatalog;
}

export async function reconcileStripeCatalog(secretKey: string, catalog: StripeCatalog, apply: boolean, request: Fetch = fetch): Promise<StripeSyncReport> {
  const items: StripeSyncItem[] = [];
  const prices: Record<string, string> = {};
  for (const [plan, definition] of Object.entries(catalog.plans)) {
    const lookupKey = `trestle_${plan}_v${definition.version}`;
    const query = new URLSearchParams({ "lookup_keys[]": lookupKey, active: "true", "expand[]": "data.product" });
    const existing = await stripeRequest<{ data: Array<{ id: string; currency: string; unit_amount: number | null; recurring?: { interval: string } | null }> }>(secretKey, `/v1/prices?${query}`, {}, request);
    const price = existing.data[0];
    if (price) {
      if (price.currency === catalog.currency && price.unit_amount === definition.unitAmount && price.recurring?.interval === definition.interval) {
        items.push({ plan, lookupKey, classification: "already_correct", priceId: price.id });
        prices[plan] = price.id;
      } else items.push({ plan, lookupKey, classification: "blocked", priceId: price.id, reason: "an immutable price with this lookup key has different billing terms; declare a new plan version" });
      continue;
    }
    if (!apply) { items.push({ plan, lookupKey, classification: "create" }); continue; }
    const product = await stripeRequest<{ id: string }>(secretKey, "/v1/products", { method: "POST", body: new URLSearchParams({ name: definition.name, "metadata[trestle_plan]": plan, "metadata[trestle_plan_version]": String(definition.version) }) }, request);
    const created = await stripeRequest<{ id: string }>(secretKey, "/v1/prices", { method: "POST", body: new URLSearchParams({ product: product.id, currency: catalog.currency, unit_amount: String(definition.unitAmount), "recurring[interval]": definition.interval, lookup_key: lookupKey }) }, request);
    items.push({ plan, lookupKey, classification: "already_correct", priceId: created.id });
    prices[plan] = created.id;
  }
  return { items, prices };
}
