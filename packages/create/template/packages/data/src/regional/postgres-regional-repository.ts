import { createSqlRunner, tenantConnectionString, type DatabaseDriver, type SqlRow, type SqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";
import type { Mutation, OrganizationRegionalRecord, RegionalRepository, UserRegionalRecord } from "@__TRESTLE_PROJECT_NAME__/domain";
import { sql, type SQL } from "drizzle-orm";

import { mutationRecords } from "../access/postgres-tenant-access-repository.js";

const text = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
const organizationRecord = (row: SqlRow): OrganizationRegionalRecord => ({ language: text(row.language), locale: text(row.locale), timeZone: text(row.time_zone), currency: text(row.currency) });
const userRecord = (row: SqlRow): UserRegionalRecord => ({ language: text(row.language), locale: text(row.locale), timeZone: text(row.time_zone) });

/**
 * Regional settings on the restricted tenant role. Organization rows use
 * forced tenant RLS; user rows use forced RLS on `app.user_id`, which is set
 * only inside the transaction that reads or writes that user's preferences.
 */
export class PostgresRegionalRepository implements RegionalRepository {
  private readonly tenant: SqlRunner;

  constructor(databaseUrl: string, driver: DatabaseDriver | undefined, private readonly organizationId: string) {
    this.tenant = createSqlRunner(tenantConnectionString(databaseUrl, organizationId), driver);
  }

  private asUser(userId: string): SQL {
    if (!userId) throw new Error("A user is required");
    return sql`select set_config('app.user_id', ${userId}, true)`;
  }

  private checkTenant(mutation: Mutation): void {
    if (mutation.context.organizationId !== this.organizationId) throw new Error("Mutation context does not match the repository tenant");
  }

  async organizationSettings(): Promise<OrganizationRegionalRecord | null> {
    const [row] = await this.tenant.query(sql`select language, locale, time_zone, currency from organization_regional_settings where organization_id = ${this.organizationId}`);
    return row ? organizationRecord(row) : null;
  }

  async saveOrganizationSettings(values: OrganizationRegionalRecord, mutation: Mutation): Promise<void> {
    this.checkTenant(mutation);
    await this.tenant.atomic([
      sql`insert into organization_regional_settings (organization_id, language, locale, time_zone, currency, updated_by, updated_at)
          values (${this.organizationId}, ${values.language}, ${values.locale}, ${values.timeZone}, ${values.currency}, ${`${mutation.context.actor.type}:${mutation.context.actor.id}`}, ${mutation.context.now})
          on conflict (organization_id) do update set language = excluded.language, locale = excluded.locale, time_zone = excluded.time_zone, currency = excluded.currency, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ...mutationRecords(mutation),
    ]);
  }

  async userPreference(userId: string): Promise<UserRegionalRecord | null> {
    const [, rows] = await this.tenant.atomic([this.asUser(userId), sql`select language, locale, time_zone from user_regional_preference where user_id = ${userId}`]);
    const [row] = rows ?? [];
    return row ? userRecord(row) : null;
  }

  async saveUserPreference(userId: string, values: UserRegionalRecord, mutation: Mutation): Promise<void> {
    this.checkTenant(mutation);
    const inheritsEverything = values.language === null && values.locale === null && values.timeZone === null;
    await this.tenant.atomic([
      this.asUser(userId),
      inheritsEverything
        ? sql`delete from user_regional_preference where user_id = ${userId}`
        : sql`insert into user_regional_preference (user_id, language, locale, time_zone, updated_at) values (${userId}, ${values.language}, ${values.locale}, ${values.timeZone}, ${mutation.context.now})
              on conflict (user_id) do update set language = excluded.language, locale = excluded.locale, time_zone = excluded.time_zone, updated_at = excluded.updated_at`,
      ...mutationRecords(mutation),
    ]);
  }
}
