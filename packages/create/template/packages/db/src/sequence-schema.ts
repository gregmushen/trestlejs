import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgPolicy, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * One recipient's progress through a `defineSequence` email sequence. The
 * recipient address is stored normalized, as `email_suppression` stores it,
 * because every send needs it; events and audit identify the recipient only by
 * `recipient_hash`. A repeated trigger never starts a second active run for the
 * same sequence, organization and user, and one trigger event starts at most
 * one run.
 */
export const sequenceRun = pgTable("sequence_run", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  sequenceId: text("sequence_id").notNull(),
  kind: text("kind").notNull(),
  userId: text("user_id").notNull(),
  recipientAddress: text("recipient_address").notNull(),
  recipientHash: text("recipient_hash").notNull(),
  timeZone: text("time_zone"),
  /** The committed outbox event that started the run; its row is the run's provenance. */
  triggerEventId: text("trigger_event_id").notNull(),
  status: text("status").notNull(),
  exitReason: text("exit_reason"),
  /** The next step to execute; equal to the step count once the run completed. */
  currentStep: integer("current_step").default(0).notNull(),
  /** When the waiting step is due, in UTC; null while a step is executing or once the run ended. */
  nextAt: timestamp("next_at", { withTimezone: true }),
  /** The job runtime executing the run and its own run or instance ID, for cancellation and dashboard links. */
  engine: text("engine").notNull(),
  engineRunId: text("engine_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("sequence_run_active_uidx").on(table.organizationId, table.sequenceId, table.userId).where(sql`${table.status} = 'active'`),
  uniqueIndex("sequence_run_trigger_uidx").on(table.organizationId, table.sequenceId, table.triggerEventId),
  index("sequence_run_recipient_idx").on(table.organizationId, table.recipientHash),
  index("sequence_run_user_idx").on(table.organizationId, table.userId),
  index("sequence_run_sequence_status_idx").on(table.sequenceId, table.status),
  check("sequence_run_status_check", sql`${table.status} IN ('active', 'completed', 'exited', 'failed')`),
  check("sequence_run_kind_check", sql`${table.kind} IN ('marketing', 'transactional')`),
  check("sequence_run_address_check", sql`${table.recipientAddress} = lower(${table.recipientAddress})`),
  check("sequence_run_hash_check", sql`${table.recipientHash} ~ '^[0-9a-f]{64}$'`),
  check("sequence_run_step_check", sql`${table.currentStep} >= 0`),
  check("sequence_run_exit_reason_check", sql`(${table.status} IN ('exited', 'failed')) = (${table.exitReason} IS NOT NULL)`),
  pgPolicy("sequence_run_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
  pgPolicy("sequence_run_platform_select", { for: "select", to: "trestle_platform", using: sql`true` }),
  // Operators end an active run with a reason; the audit event commits in the same transaction.
  pgPolicy("sequence_run_platform_exit", { for: "update", to: "trestle_platform", using: sql`${table.status} = 'active'`, withCheck: sql`${table.status} = 'exited'` }),
]).enableRLS();

/**
 * One email a sequence run sent. It commits in the same transaction that
 * advances the run past the step, and `idempotency_key` is the key Resend
 * received, so a retried step never sends or records twice.
 */
export const sequenceSend = pgTable("sequence_send", {
  runId: text("run_id").notNull(),
  organizationId: text("organization_id").notNull(),
  stepIndex: integer("step_index").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  emailDeliveryId: text("email_delivery_id").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.stepIndex] }),
  foreignKey({ columns: [table.runId], foreignColumns: [sequenceRun.id] }).onDelete("cascade"),
  uniqueIndex("sequence_send_idempotency_uidx").on(table.idempotencyKey),
  index("sequence_send_sent_idx").on(table.sentAt),
  check("sequence_send_step_check", sql`${table.stepIndex} >= 0`),
  pgPolicy("sequence_send_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
  pgPolicy("sequence_send_platform_select", { for: "select", to: "trestle_platform", using: sql`true` }),
]).enableRLS();
