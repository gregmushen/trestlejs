import { sql } from "drizzle-orm";
import { check, index, jsonb, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Append-only record of sensitive administrative actions. Rows are never
 * updated or deleted by the application; the runtime role may only insert
 * and read its own organization's rows. Summaries are redacted before
 * insertion (see recordAuditEvent) and never hold secrets or message bodies.
 * Platform rows (organization_id null) are invisible to tenants.
 */
export const auditEvent = pgTable("audit_event", {
  id: uuid("id").defaultRandom().primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  name: text("name").notNull(),
  schemaVersion: text("schema_version").default("1").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  organizationId: text("organization_id"),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  reason: text("reason"),
  summary: jsonb("summary").$type<Record<string, unknown>>().default({}).notNull(),
  outcome: text("outcome").notNull(),
  environment: text("environment").notNull(),
  correlationId: text("correlation_id").notNull(),
  /** Set when a platform operator acts inside an audited support session. */
  supportSessionId: text("support_session_id"),
}, (table) => [
  index("audit_event_organization_idx").on(table.organizationId, table.occurredAt),
  index("audit_event_correlation_idx").on(table.correlationId),
  check("audit_event_actor_type_check", sql`${table.actorType} IN ('user', 'service_account', 'platform_operator', 'system')`),
  check("audit_event_outcome_check", sql`${table.outcome} IN ('succeeded', 'denied', 'failed')`),
  pgPolicy("audit_event_tenant_select", { for: "select", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
  pgPolicy("audit_event_tenant_insert", { for: "insert", to: "trestle_app", withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
  // The platform admin reads all history and records platform actions (any tenant or none).
  pgPolicy("audit_event_platform_select", { for: "select", to: "trestle_platform", using: sql`true` }),
  pgPolicy("audit_event_platform_insert", { for: "insert", to: "trestle_platform", withCheck: sql`true` }),
]).enableRLS();
