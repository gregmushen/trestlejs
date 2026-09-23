CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"schema_version" text DEFAULT '1' NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"organization_id" text,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"environment" text NOT NULL,
	"correlation_id" text NOT NULL,
	"support_session_id" text,
	CONSTRAINT "audit_event_actor_type_check" CHECK ("audit_event"."actor_type" IN ('user', 'service_account', 'platform_operator', 'system')),
	CONSTRAINT "audit_event_outcome_check" CHECK ("audit_event"."outcome" IN ('succeeded', 'denied', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "audit_event_organization_idx" ON "audit_event" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_event_correlation_idx" ON "audit_event" USING btree ("correlation_id");--> statement-breakpoint
CREATE POLICY "audit_event_tenant_select" ON "audit_event" AS PERMISSIVE FOR SELECT TO "trestle_app" USING ("audit_event"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "audit_event_tenant_insert" ON "audit_event" AS PERMISSIVE FOR INSERT TO "trestle_app" WITH CHECK ("audit_event"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Append-only: the runtime role may insert and read its tenant's rows; no role in the
-- application may update or delete audit history.
REVOKE ALL ON "audit_event" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_event" TO trestle_app;
