import { eq } from "drizzle-orm";

import { recordAuditEvent, type AuditEventInput } from "./audit.js";
import type { Database } from "./index.js";
import { organizationRegionalSettings } from "./regional-schema.js";

export type RegionalOverrides = Readonly<{ language: string | null; locale: string | null; timeZone: string | null; currency: string | null }>;

const columns = { language: organizationRegionalSettings.language, locale: organizationRegionalSettings.locale, timeZone: organizationRegionalSettings.timeZone, currency: organizationRegionalSettings.currency };

/** The organization's overrides, or null when it inherits every application default. */
export async function organizationRegionalOverrides(database: Database, organizationId: string): Promise<RegionalOverrides | null> {
  const [row] = await database.select(columns).from(organizationRegionalSettings).where(eq(organizationRegionalSettings.organizationId, organizationId)).limit(1);
  return row ?? null;
}

/** Replaces the organization's overrides and records what changed in the same transaction. */
export async function replaceOrganizationRegional(database: Database, input: Readonly<{ organizationId: string; values: RegionalOverrides; actor: string; now: Date; audit: Omit<AuditEventInput, "summary"> }>): Promise<{ changed: string[] }> {
  return await database.transaction(async (transaction) => {
    const [previous] = await transaction.select(columns).from(organizationRegionalSettings).where(eq(organizationRegionalSettings.organizationId, input.organizationId)).for("update").limit(1);
    const changed = (Object.keys(input.values) as Array<keyof RegionalOverrides>).filter((key) => (previous?.[key] ?? null) !== input.values[key]);
    if (changed.length === 0) return { changed };
    await transaction.insert(organizationRegionalSettings).values({ organizationId: input.organizationId, ...input.values, updatedBy: input.actor, updatedAt: input.now })
      .onConflictDoUpdate({ target: organizationRegionalSettings.organizationId, set: { ...input.values, updatedBy: input.actor, updatedAt: input.now } });
    await recordAuditEvent(transaction, {
      ...input.audit,
      summary: Object.fromEntries(changed.map((key) => [key, { from: previous?.[key] ?? null, to: input.values[key] }])),
    });
    return { changed };
  });
}
