CREATE TABLE "sequence_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"kind" text NOT NULL,
	"user_id" text NOT NULL,
	"recipient_address" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"time_zone" text,
	"trigger_event_id" text NOT NULL,
	"status" text NOT NULL,
	"exit_reason" text,
	"current_step" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone,
	"engine" text NOT NULL,
	"engine_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequence_run_status_check" CHECK ("sequence_run"."status" IN ('active', 'completed', 'exited', 'failed')),
	CONSTRAINT "sequence_run_kind_check" CHECK ("sequence_run"."kind" IN ('marketing', 'transactional')),
	CONSTRAINT "sequence_run_address_check" CHECK ("sequence_run"."recipient_address" = lower("sequence_run"."recipient_address")),
	CONSTRAINT "sequence_run_hash_check" CHECK ("sequence_run"."recipient_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sequence_run_step_check" CHECK ("sequence_run"."current_step" >= 0),
	CONSTRAINT "sequence_run_exit_reason_check" CHECK (("sequence_run"."status" IN ('exited', 'failed')) = ("sequence_run"."exit_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "sequence_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sequence_send" (
	"run_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"email_delivery_id" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequence_send_run_id_step_index_pk" PRIMARY KEY("run_id","step_index"),
	CONSTRAINT "sequence_send_step_check" CHECK ("sequence_send"."step_index" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sequence_send" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sequence_send" ADD CONSTRAINT "sequence_send_run_id_sequence_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sequence_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_run_active_uidx" ON "sequence_run" USING btree ("organization_id","sequence_id","user_id") WHERE "sequence_run"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_run_trigger_uidx" ON "sequence_run" USING btree ("organization_id","sequence_id","trigger_event_id");--> statement-breakpoint
CREATE INDEX "sequence_run_recipient_idx" ON "sequence_run" USING btree ("organization_id","recipient_hash");--> statement-breakpoint
CREATE INDEX "sequence_run_user_idx" ON "sequence_run" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "sequence_run_sequence_status_idx" ON "sequence_run" USING btree ("sequence_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_send_idempotency_uidx" ON "sequence_send" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "sequence_send_sent_idx" ON "sequence_send" USING btree ("sent_at");--> statement-breakpoint
CREATE POLICY "sequence_run_tenant" ON "sequence_run" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("sequence_run"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("sequence_run"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "sequence_run_platform_select" ON "sequence_run" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
CREATE POLICY "sequence_run_platform_exit" ON "sequence_run" AS PERMISSIVE FOR UPDATE TO "trestle_platform" USING ("sequence_run"."status" = 'active') WITH CHECK ("sequence_run"."status" = 'exited');--> statement-breakpoint
CREATE POLICY "sequence_send_tenant" ON "sequence_send" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("sequence_send"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("sequence_send"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "sequence_send_platform_select" ON "sequence_send" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
ALTER TABLE "sequence_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sequence_send" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Sequence consumers and steps run under the committed event's tenant: they start, advance,
-- and end runs and record sends. The application never deletes a run or rewrites a send.
GRANT SELECT, INSERT, UPDATE ON "sequence_run" TO trestle_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "sequence_send" TO trestle_app;--> statement-breakpoint
-- Platform operators read runs and sends and end an active run with a reason (audited in the
-- same transaction); they never start, advance, or rewrite one.
GRANT SELECT ON "sequence_run", "sequence_send" TO trestle_platform;--> statement-breakpoint
GRANT UPDATE ("status", "exit_reason", "next_at", "updated_at") ON "sequence_run" TO trestle_platform;