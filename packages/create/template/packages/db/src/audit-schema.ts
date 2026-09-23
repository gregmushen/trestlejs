import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Append-only administrative and access audit history. Summaries are redacted before insert. */
export const auditEvent = pgTable("audit_event", {
  id: uuid("id").defaultRandom().primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  name: text("name").notNull(),
  schemaVersion: integer("schema_version").default(1).notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  organizationId: text("organization_id"),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  reason: text("reason"),
  summary: jsonb("summary").$type<Record<string, unknown>>().default({}).notNull(),
  outcome: text("outcome").$type<"succeeded" | "denied" | "failed">().notNull(),
  environment: text("environment").notNull(),
  correlationId: text("correlation_id").notNull(),
  /** Set on every record produced inside a platform support session. */
  supportSessionId: text("support_session_id"),
}, (table) => [
  index("audit_event_organization_idx").on(table.organizationId, table.occurredAt),
  index("audit_event_name_idx").on(table.name, table.occurredAt),
  index("audit_event_actor_idx").on(table.actorId, table.occurredAt),
  index("audit_event_support_session_idx").on(table.supportSessionId),
]);
