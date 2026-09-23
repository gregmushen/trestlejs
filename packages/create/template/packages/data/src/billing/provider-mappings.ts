import type { SqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";
import { sql } from "drizzle-orm";

/**
 * Explicit billing provider mappings (docs/ADMIN_REQUIRED_CHANGES.md §4.2).
 * A Stripe Price maps to one plan version and offer; nothing is ever inferred
 * from display names. Mappings are per application environment.
 */

export type PriceMapping = Readonly<{ externalId: string; plan: string; planVersion: number; offer: string | null }>;

/** The offer used for self-serve checkout when a version has several. */
export const defaultOffer = "monthly";

/** Plan → price for checkout: the active version's default (or only unnamed) offer. */
export async function loadCheckoutPrices(runner: SqlRunner, environment: string, provider = "stripe"): Promise<Record<string, string>> {
  const rows = await runner.query(sql`select m.plan, m.external_id, m.offer from billing_provider_mapping m
    join plan_version v on v.plan = m.plan and v.version = m.plan_version and v.state = 'active'
    where m.environment = ${environment} and m.provider = ${provider} and m.kind = 'price' and (m.offer is null or m.offer = ${defaultOffer})
    order by (m.offer is null) asc`);
  const prices: Record<string, string> = {};
  for (const row of rows) prices[String(row.plan)] ??= String(row.external_id);
  return prices;
}

/** Resolves provider price IDs to the plan versions they are mapped to. Unmapped prices are absent. */
export async function resolvePriceMappings(runner: SqlRunner, environment: string, priceIds: readonly string[], provider = "stripe"): Promise<Map<string, PriceMapping>> {
  if (!priceIds.length) return new Map();
  const rows = await runner.query(sql`select external_id, plan, plan_version, offer from billing_provider_mapping
    where environment = ${environment} and provider = ${provider} and kind = 'price' and external_id in (${sql.join(priceIds.map((id) => sql`${id}`), sql`, `)})`);
  return new Map(rows.map((row) => [String(row.external_id), { externalId: String(row.external_id), plan: String(row.plan), planVersion: Number(row.plan_version), offer: row.offer ? String(row.offer) : null }]));
}
