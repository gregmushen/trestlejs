import { createSqlRunner, tenantConnectionString, type DatabaseDriver, type SqlRow, type SqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";
import type { Mutation, NotificationChannel, NotificationDeliveryRecord, NotificationRecord, NotificationRepository, PreferenceRow, Recipient } from "@__TRESTLE_PROJECT_NAME__/domain";
import { sql, type SQL } from "drizzle-orm";

import { mutationRecords } from "../access/postgres-tenant-access-repository.js";

const date = (value: unknown): Date | null => value === null || value === undefined ? null : value instanceof Date ? value : new Date(String(value));
const textArray = (values: readonly string[]) => sql`${`{${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`).join(",")}}`}::text[]`;

function notification(row: SqlRow): NotificationRecord {
  return {
    id: String(row.id), userId: String(row.user_id), type: String(row.type), title: String(row.title), body: String(row.body), link: row.link ? String(row.link) : null, groupKey: row.group_key ? String(row.group_key) : null,
    groupCount: Number(row.group_count), dedupeKey: row.dedupe_key ? String(row.dedupe_key) : null, eventId: row.event_id ? String(row.event_id) : null, correlationId: String(row.correlation_id),
    createdAt: date(row.created_at)!, updatedAt: date(row.updated_at)!, readAt: date(row.read_at),
  };
}

function delivery(row: SqlRow): NotificationDeliveryRecord {
  return {
    id: String(row.id), notificationId: String(row.notification_id), userId: String(row.user_id), type: String(row.type), channel: String(row.channel) as NotificationChannel, status: String(row.status) as NotificationDeliveryRecord["status"],
    preferenceSource: String(row.preference_source) as NotificationDeliveryRecord["preferenceSource"], mandatory: row.mandatory === true, attempts: Number(row.attempts), failureCategory: row.failure_category ? String(row.failure_category) : null,
    emailDeliveryId: row.email_delivery_id ? String(row.email_delivery_id) : null, correlationId: String(row.correlation_id), createdAt: date(row.created_at)!, completedAt: date(row.completed_at),
  };
}

/**
 * Tenant notification repository. Notifications and preferences live under
 * forced RLS; member roles and addresses come from the identity tables with an
 * explicit organization predicate.
 */
export class PostgresNotificationRepository implements NotificationRepository {
  private readonly tenant: SqlRunner;
  private readonly identity: SqlRunner;

  constructor(databaseUrl: string, driver: DatabaseDriver | undefined, private readonly organizationId: string) {
    this.tenant = createSqlRunner(tenantConnectionString(databaseUrl, organizationId), driver);
    this.identity = createSqlRunner(databaseUrl, driver);
  }

  private async write(statements: SQL[], mutation?: Mutation): Promise<void> {
    if (mutation && mutation.context.organizationId !== this.organizationId) throw new Error("Mutation context does not match the repository tenant");
    await this.tenant.atomic([...statements, ...(mutation ? mutationRecords(mutation) : [])]);
  }

  async recipients(selector: Readonly<{ organizationRoles?: readonly string[]; userIds?: readonly string[] }>): Promise<Recipient[]> {
    const rows = await this.identity.query(sql`select m.user_id, m.role, u.name, u.email from member m join "user" u on u.id = m.user_id where m.organization_id = ${this.organizationId} and u.suspended_at is null`);
    return rows.filter((row) => {
      const roles = String(row.role ?? "").split(",").map((role) => role.trim());
      return (selector.organizationRoles ?? []).some((role) => roles.includes(role)) || (selector.userIds ?? []).includes(String(row.user_id));
    }).map((row) => ({ userId: String(row.user_id), name: String(row.name), email: String(row.email) }));
  }

  async preferences(userIds: readonly string[]): Promise<PreferenceRow[]> {
    return (await this.tenant.query(sql`select user_id, type, channel, enabled from notification_preference where organization_id = ${this.organizationId} and (user_id = '*' or user_id = any(${textArray(userIds)}))`))
      .map((row) => ({ userId: String(row.user_id), type: String(row.type), channel: String(row.channel) as NotificationChannel, enabled: row.enabled === true }));
  }

  async findRecent(userId: string, type: string, key: Readonly<{ dedupeKey?: string; groupKey?: string }>, since: Date): Promise<NotificationRecord | null> {
    const match = key.dedupeKey ? sql`dedupe_key = ${key.dedupeKey}` : sql`group_key = ${key.groupKey ?? ""}`;
    const [row] = await this.tenant.query(sql`select * from notification where organization_id = ${this.organizationId} and user_id = ${userId} and type = ${type} and ${match} and updated_at >= ${since} order by updated_at desc limit 1`);
    return row ? notification(row) : null;
  }

  async insert(value: NotificationRecord, deliveries: readonly (Omit<NotificationDeliveryRecord, "type" | "createdAt" | "completedAt"> & { nextAttemptAt?: Date })[]): Promise<void> {
    await this.write([
      sql`insert into notification (id, organization_id, user_id, type, title, body, link, group_key, group_count, dedupe_key, event_id, correlation_id, created_at, updated_at, scheduled_at, stream_version)
        values (${value.id}, ${this.organizationId}, ${value.userId}, ${value.type}, ${value.title}, ${value.body}, ${value.link}, ${value.groupKey}, ${value.groupCount}, ${value.dedupeKey}, ${value.eventId}, ${value.correlationId}, ${value.createdAt}, ${value.updatedAt}, ${value.scheduledAt ?? value.createdAt}, ${value.streamVersion ?? null})`,
      ...deliveries.map((entry) => sql`insert into notification_delivery (id, organization_id, notification_id, user_id, channel, status, preference_source, mandatory, correlation_id, completed_at, failure_category, next_attempt_at)
        values (${entry.id}, ${this.organizationId}, ${value.id}, ${entry.userId}, ${entry.channel}, ${entry.status}, ${entry.preferenceSource}, ${entry.mandatory}, ${entry.correlationId}, ${entry.status === "pending" ? null : value.createdAt}, ${entry.failureCategory}, ${entry.nextAttemptAt ?? value.createdAt})`),
    ]);
  }

  async regroup(id: string, content: Readonly<{ title: string; body: string; link: string | null }>, groupCount: number, now: Date): Promise<void> {
    await this.write([sql`update notification set title = ${content.title}, body = ${content.body}, link = ${content.link}, group_count = ${groupCount}, updated_at = ${now} where organization_id = ${this.organizationId} and id = ${id}`]);
  }

  async inbox(userId: string, limit: number): Promise<NotificationRecord[]> {
    return (await this.tenant.query(sql`select * from notification where organization_id = ${this.organizationId} and user_id = ${userId} and scheduled_at <= now() order by updated_at desc limit ${Math.min(Math.max(limit, 1), 200)}`)).map(notification);
  }

  async unreadCount(userId: string): Promise<number> {
    return Number((await this.tenant.query(sql`select count(*) as unread from notification where organization_id = ${this.organizationId} and user_id = ${userId} and read_at is null and scheduled_at <= now()`))[0]?.unread ?? 0);
  }

  async markRead(userId: string, ids: readonly string[] | "all", now: Date): Promise<number> {
    const rows = await this.tenant.query(sql`update notification set read_at = ${now} where organization_id = ${this.organizationId} and user_id = ${userId} and read_at is null ${ids === "all" ? sql`` : sql`and id = any(${textArray(ids)})`} returning id`);
    return rows.length;
  }

  async setPreference(row: PreferenceRow, updatedBy: string, mutation?: Mutation): Promise<void> {
    await this.write([sql`insert into notification_preference (organization_id, user_id, type, channel, enabled, updated_by) values (${this.organizationId}, ${row.userId}, ${row.type}, ${row.channel}, ${row.enabled}, ${updatedBy})
      on conflict (organization_id, user_id, type, channel) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()`], mutation);
  }

  async clearPreference(userId: string, type: string, channel: NotificationChannel, mutation?: Mutation): Promise<void> {
    await this.write([sql`delete from notification_preference where organization_id = ${this.organizationId} and user_id = ${userId} and type = ${type} and channel = ${channel}`], mutation);
  }

  async deliveries(filter: Readonly<{ limit: number; notificationId?: string }>): Promise<NotificationDeliveryRecord[]> {
    return (await this.tenant.query(sql`select d.*, n.type from notification_delivery d join notification n on n.id = d.notification_id where d.organization_id = ${this.organizationId} ${filter.notificationId ? sql`and d.notification_id = ${filter.notificationId}` : sql``}
      order by d.created_at desc limit ${Math.min(Math.max(filter.limit, 1), 500)}`)).map(delivery);
  }

  async delivery(id: string) {
    const [row] = await this.tenant.query(sql`select d.*, n.type, n.title, n.body, n.link from notification_delivery d join notification n on n.id = d.notification_id where d.organization_id = ${this.organizationId} and d.id = ${id}`);
    if (!row) return null;
    const [user] = await this.identity.query(sql`select u.email from "user" u join member m on m.user_id = u.id where u.id = ${String(row.user_id)} and m.organization_id = ${this.organizationId}`);
    return { ...delivery(row), recipientEmail: user?.email ? String(user.email) : null, content: { title: String(row.title), body: String(row.body), link: row.link ? String(row.link) : null } };
  }

  async completeDelivery(id: string, result: Readonly<{ status: "sent" | "failed" | "pending"; failureCategory: string | null; emailDeliveryId: string | null; nextAttemptAt: Date | null }>, now: Date): Promise<void> {
    await this.write([sql`update notification_delivery set status = ${result.status}, attempts = attempts + 1, failure_category = ${result.failureCategory}, email_delivery_id = coalesce(${result.emailDeliveryId}, email_delivery_id),
      next_attempt_at = coalesce(${result.nextAttemptAt}, next_attempt_at), completed_at = ${result.status === "pending" ? null : now} where organization_id = ${this.organizationId} and id = ${id} and status = 'pending'`]);
  }
}
