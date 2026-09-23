DROP TABLE "platform_tenant_context" CASCADE;
--> statement-breakpoint
CREATE TABLE "support_session" (
	"id" text PRIMARY KEY NOT NULL,
	"operator_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"reason" text NOT NULL,
	"ticket" text,
	"profile" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"ended_by" text,
	"revocation_reason" text
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"group_key" text,
	"group_count" integer DEFAULT 1 NOT NULL,
	"dedupe_key" text,
	"event_id" text,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"notification_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"preference_source" text NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure_category" text,
	"email_delivery_id" text,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_preference" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preference_organization_id_user_id_type_channel_pk" PRIMARY KEY("organization_id","user_id","type","channel")
);
--> statement-breakpoint
CREATE TABLE "webhook_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response_code" integer,
	"failure_category" text,
	"duration_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_name" text NOT NULL,
	"event_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_response_code" integer,
	"failure_category" text,
	"correlation_id" text NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"replay_of" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoint" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"url_display" text NOT NULL,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"disabled_reason" text,
	"disabled_by" text,
	"disabled_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_fingerprint" text NOT NULL,
	"secret_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"previous_secret_ciphertext" text,
	"previous_secret_expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_event" ADD COLUMN "support_session_id" text;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_notification_id_notification_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_attempt" ADD CONSTRAINT "webhook_attempt_delivery_id_webhook_delivery_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."webhook_delivery"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpoint_id_webhook_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_session_operator_idx" ON "support_session" USING btree ("operator_id","started_at");--> statement-breakpoint
CREATE INDEX "support_session_organization_idx" ON "support_session" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_session_active_uidx" ON "support_session" USING btree ("operator_id") WHERE "support_session"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "notification_inbox_idx" ON "notification" USING btree ("organization_id","user_id","updated_at");--> statement-breakpoint
CREATE INDEX "notification_group_idx" ON "notification" USING btree ("organization_id","user_id","type","group_key");--> statement-breakpoint
CREATE INDEX "notification_delivery_notification_idx" ON "notification_delivery" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "notification_delivery_due_idx" ON "notification_delivery" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_attempt_delivery_idx" ON "webhook_attempt" USING btree ("delivery_id","attempted_at");--> statement-breakpoint
CREATE INDEX "webhook_delivery_endpoint_idx" ON "webhook_delivery" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_delivery_due_idx" ON "webhook_delivery" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_delivery_event_uidx" ON "webhook_delivery" USING btree ("endpoint_id","event_id") WHERE "webhook_delivery"."replay_of" is null and "webhook_delivery"."test" = false;--> statement-breakpoint
CREATE INDEX "webhook_endpoint_organization_idx" ON "webhook_endpoint" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "audit_event_support_session_idx" ON "audit_event" USING btree ("support_session_id");
--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "webhook_endpoint" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "webhook_endpoint_tenant" ON "webhook_endpoint" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "webhook_endpoint_platform" ON "webhook_endpoint" TO trestle_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "webhook_delivery" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "webhook_delivery" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "webhook_delivery_tenant" ON "webhook_delivery" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "webhook_delivery_platform" ON "webhook_delivery" TO trestle_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "webhook_attempt" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "webhook_attempt" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "webhook_attempt_tenant" ON "webhook_attempt" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "webhook_attempt_platform" ON "webhook_attempt" FOR SELECT TO trestle_platform USING (true);
--> statement-breakpoint
ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notification_tenant" ON "notification" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "notification_platform" ON "notification" FOR SELECT TO trestle_platform USING (true);
--> statement-breakpoint
ALTER TABLE "notification_delivery" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification_delivery" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notification_delivery_tenant" ON "notification_delivery" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "notification_delivery_platform" ON "notification_delivery" TO trestle_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "notification_preference" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification_preference" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notification_preference_tenant" ON "notification_preference" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "notification_preference_platform" ON "notification_preference" FOR SELECT TO trestle_platform USING (true);
--> statement-breakpoint
REVOKE ALL ON "webhook_endpoint", "webhook_delivery", "webhook_attempt", "notification", "notification_delivery", "notification_preference", "support_session" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_endpoint", "notification_preference" TO trestle_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "webhook_delivery", "notification", "notification_delivery" TO trestle_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "webhook_attempt" TO trestle_app;
--> statement-breakpoint
-- Operators see sanitized endpoint metadata only: never the raw URL or any signing secret.
GRANT SELECT ("id", "organization_id", "name", "url_display", "events", "state", "disabled_reason", "disabled_by", "disabled_at", "consecutive_failures", "secret_fingerprint", "secret_created_at", "verified_at", "last_success_at", "last_failure_at", "created_by", "created_at", "updated_at") ON "webhook_endpoint" TO trestle_platform;
--> statement-breakpoint
GRANT UPDATE ("state", "disabled_reason", "disabled_by", "disabled_at", "updated_at") ON "webhook_endpoint" TO trestle_platform;
--> statement-breakpoint
-- Delivery metadata without the payload.
GRANT SELECT ("id", "organization_id", "endpoint_id", "event_id", "event_name", "event_version", "status", "attempts", "next_attempt_at", "last_response_code", "failure_category", "correlation_id", "test", "replay_of", "created_at", "completed_at") ON "webhook_delivery" TO trestle_platform;
--> statement-breakpoint
-- Emergency disable cancels queued deliveries.
GRANT UPDATE ("status", "completed_at") ON "webhook_delivery" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT ON "webhook_attempt", "notification_preference" TO trestle_platform;
--> statement-breakpoint
-- Notification metadata without the title, body, or link.
GRANT SELECT ("id", "organization_id", "user_id", "type", "group_key", "group_count", "dedupe_key", "event_id", "correlation_id", "created_at", "updated_at", "scheduled_at", "read_at") ON "notification" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT ON "notification_delivery" TO trestle_platform;
--> statement-breakpoint
GRANT UPDATE ("status", "attempts", "next_attempt_at", "failure_category", "completed_at") ON "notification_delivery" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "support_session" TO trestle_platform;
--> statement-breakpoint
-- The dispatcher finds due work across tenants through these narrow functions,
-- then processes each item on a tenant-bound connection under forced RLS.
CREATE OR REPLACE FUNCTION trestle_due_webhook_deliveries(p_limit integer)
RETURNS TABLE (id text, organization_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT d.id, d.organization_id FROM public.webhook_delivery d
    JOIN public.webhook_endpoint e ON e.id = d.endpoint_id AND e.state = 'active'
   WHERE d.status = 'pending' AND d.next_attempt_at <= now()
   ORDER BY d.next_attempt_at LIMIT least(greatest(p_limit, 1), 100)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trestle_due_notification_deliveries(p_limit integer)
RETURNS TABLE (id text, organization_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT d.id, d.organization_id FROM public.notification_delivery d
   WHERE d.status = 'pending' AND d.next_attempt_at <= now()
   ORDER BY d.next_attempt_at LIMIT least(greatest(p_limit, 1), 100)
$$;
--> statement-breakpoint
-- Platform replay copies a completed delivery (payload included) without the
-- platform role ever reading the payload. Eligibility is enforced here too.
CREATE OR REPLACE FUNCTION trestle_replay_webhook_delivery(p_delivery_id text, p_new_id text, p_correlation_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_organization text;
BEGIN
  INSERT INTO public.webhook_delivery (id, organization_id, endpoint_id, event_id, event_name, event_version, payload, status, correlation_id, test, replay_of)
  SELECT p_new_id, d.organization_id, d.endpoint_id, d.event_id, d.event_name, d.event_version, d.payload, 'pending', p_correlation_id, false, d.id
    FROM public.webhook_delivery d JOIN public.webhook_endpoint e ON e.id = d.endpoint_id
   WHERE d.id = p_delivery_id AND d.status IN ('failed', 'succeeded') AND d.test = false AND e.state = 'active'
  RETURNING organization_id INTO v_organization;
  RETURN v_organization;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION trestle_due_webhook_deliveries(integer), trestle_due_notification_deliveries(integer), trestle_replay_webhook_delivery(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trestle_due_webhook_deliveries(integer), trestle_due_notification_deliveries(integer) TO trestle_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trestle_replay_webhook_delivery(text, text, text) TO trestle_platform;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY "webhook_delivery_owner" ON "webhook_delivery" TO %I USING (true) WITH CHECK (true)', current_user);
    EXECUTE format('CREATE POLICY "webhook_endpoint_owner" ON "webhook_endpoint" FOR SELECT TO %I USING (true)', current_user);
    EXECUTE format('CREATE POLICY "notification_delivery_owner" ON "notification_delivery" FOR SELECT TO %I USING (true)', current_user);
  END IF;
END
$$;
