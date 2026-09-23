import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Tenant outbound webhook endpoint. The signing secret is stored encrypted and
 * is never granted to the platform role; `url_display` is the sanitized form
 * operators see (no credentials, query, or fragment).
 */
export const webhookEndpoint = pgTable("webhook_endpoint", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  urlDisplay: text("url_display").notNull(),
  events: text("events").array().default(sql`'{}'::text[]`).notNull(),
  state: text("state").$type<"active" | "paused" | "disabled">().default("active").notNull(),
  disabledReason: text("disabled_reason"),
  disabledBy: text("disabled_by"),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  secretFingerprint: text("secret_fingerprint").notNull(),
  secretCreatedAt: timestamp("secret_created_at", { withTimezone: true }).defaultNow().notNull(),
  previousSecretCiphertext: text("previous_secret_ciphertext"),
  previousSecretExpiresAt: timestamp("previous_secret_expires_at", { withTimezone: true }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  description: text("description"),
  /** Per-endpoint delivery timeout, bounded by the dispatcher. */
  timeoutMs: integer("timeout_ms").default(10_000).notNull(),
  /** Deleted endpoints are tombstones: never delivered to, history retained. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: text("deleted_by"),
  deletionReason: text("deletion_reason"),
}, (table) => [index("webhook_endpoint_organization_idx").on(table.organizationId)]);

/** One registered event destined for one endpoint. `payload` is the public projection, never the internal event. */
export const webhookDelivery = pgTable("webhook_delivery", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  endpointId: text("endpoint_id").notNull().references(() => webhookEndpoint.id, { onDelete: "cascade" }),
  eventId: text("event_id").notNull(),
  eventName: text("event_name").notNull(),
  eventVersion: integer("event_version").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").$type<"pending" | "succeeded" | "failed" | "cancelled">().default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
  lastResponseCode: integer("last_response_code"),
  failureCategory: text("failure_category"),
  correlationId: text("correlation_id").notNull(),
  test: boolean("test").default(false).notNull(),
  replayOf: text("replay_of"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("webhook_delivery_endpoint_idx").on(table.endpointId, table.createdAt),
  index("webhook_delivery_due_idx").on(table.status, table.nextAttemptAt),
  uniqueIndex("webhook_delivery_event_uidx").on(table.endpointId, table.eventId).where(sql`${table.replayOf} is null and ${table.test} = false`),
]);

export const webhookAttempt = pgTable("webhook_attempt", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  deliveryId: text("delivery_id").notNull().references(() => webhookDelivery.id, { onDelete: "cascade" }),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }).defaultNow().notNull(),
  responseCode: integer("response_code"),
  failureCategory: text("failure_category"),
  durationMs: integer("duration_ms").notNull(),
  /** A dispatch provider's message ID (for example Svix); never the Trestle event identity. */
  providerReference: text("provider_reference"),
}, (table) => [index("webhook_attempt_delivery_idx").on(table.deliveryId, table.attemptedAt)]);

/** A notification for one user. Title and body stay tenant-side; the platform role cannot read them. */
export const notification = pgTable("notification", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  link: text("link"),
  groupKey: text("group_key"),
  groupCount: integer("group_count").default(1).notNull(),
  dedupeKey: text("dedupe_key"),
  eventId: text("event_id"),
  correlationId: text("correlation_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).defaultNow().notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  /** The published stream version this notification was resolved against. */
  streamVersion: integer("stream_version"),
}, (table) => [
  index("notification_inbox_idx").on(table.organizationId, table.userId, table.updatedAt),
  index("notification_group_idx").on(table.organizationId, table.userId, table.type, table.groupKey),
]);

export const notificationDelivery = pgTable("notification_delivery", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  notificationId: text("notification_id").notNull().references(() => notification.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  channel: text("channel").$type<"in_app" | "email">().notNull(),
  status: text("status").$type<"pending" | "sent" | "failed" | "skipped" | "cancelled">().notNull(),
  /** Why the channel is on or off: mandatory, user, organization, or default. */
  preferenceSource: text("preference_source").notNull(),
  mandatory: boolean("mandatory").default(false).notNull(),
  attempts: integer("attempts").default(0).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
  failureCategory: text("failure_category"),
  emailDeliveryId: text("email_delivery_id"),
  correlationId: text("correlation_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("notification_delivery_notification_idx").on(table.notificationId),
  index("notification_delivery_due_idx").on(table.status, table.nextAttemptAt),
]);

/** `user_id = '*'` holds the organization default for a type and channel. */
export const notificationPreference = pgTable("notification_preference", {
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  channel: text("channel").notNull(),
  enabled: boolean("enabled").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.organizationId, table.userId, table.type, table.channel] })]);

/**
 * Notification streams (docs/ADMIN_REQUIRED_CHANGES.md §8.1): the stable
 * contract behind ctx.notifications.send({ type, recipient, data }). The type
 * key is immutable; published versions are immutable and archived, never erased.
 */
export const notificationStream = pgTable("notification_stream", {
  type: text("type").primaryKey(),
  name: text("name").notNull(),
  description: text("description").default("").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archivedBy: text("archived_by"),
});

export const notificationStreamVersion = pgTable("notification_stream_version", {
  type: text("type").notNull().references(() => notificationStream.type, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  state: text("state").$type<"draft" | "active" | "superseded" | "archived">().default("draft").notNull(),
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  publishedBy: text("published_by"),
}, (table) => [
  primaryKey({ columns: [table.type, table.version] }),
  uniqueIndex("notification_stream_active_uidx").on(table.type).where(sql`${table.state} = 'active'`),
  uniqueIndex("notification_stream_draft_uidx").on(table.type).where(sql`${table.state} = 'draft'`),
]);
