CREATE TABLE "integration_provider_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backend" text NOT NULL,
	"environment" text NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"provider_config_key" text,
	"backend_connection_id" text,
	"organization_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_provider_event_outcome_check" CHECK ("integration_provider_event"."outcome" IN ('applied', 'duplicate', 'quarantined', 'ignored')),
	CONSTRAINT "integration_provider_event_key_check" CHECK ("integration_provider_event"."event_key" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "integration_provider_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_provider_event_key_uidx" ON "integration_provider_event" USING btree ("backend","environment","event_key");--> statement-breakpoint
CREATE INDEX "integration_provider_event_outcome_idx" ON "integration_provider_event" USING btree ("outcome","received_at");--> statement-breakpoint
CREATE POLICY "integration_provider_event_platform_select" ON "integration_provider_event" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
ALTER TABLE "integration_provider_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "integration_provider_event" FROM PUBLIC;--> statement-breakpoint
-- Platform operators read callback outcomes; nothing else reads or changes them.
GRANT SELECT ON "integration_provider_event" TO trestle_platform;--> statement-breakpoint
-- A callback is recorded before any tenant is known, so the runtime role writes
-- only through this function: one row per (backend, environment, content key),
-- and it learns only whether this delivery wrote the row.
CREATE OR REPLACE FUNCTION trestle_record_integration_event(p_backend text, p_environment text, p_event_key text, p_kind text, p_outcome text, p_reason text, p_provider_config_key text, p_backend_connection_id text, p_organization_id text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted integer;
BEGIN
  INSERT INTO public.integration_provider_event (backend, environment, event_key, kind, outcome, reason, provider_config_key, backend_connection_id, organization_id)
  VALUES (p_backend, p_environment, p_event_key, left(p_kind, 64), p_outcome, left(p_reason, 64), left(p_provider_config_key, 255), left(p_backend_connection_id, 255), p_organization_id)
  -- A redelivery that now resolves (for example after the backend confirmed the
  -- connection) replaces an earlier quarantine; otherwise the first outcome stands.
  ON CONFLICT (backend, environment, event_key) DO UPDATE
    SET outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, organization_id = EXCLUDED.organization_id, received_at = now()
    WHERE public.integration_provider_event.outcome = 'quarantined' AND EXCLUDED.outcome = 'applied';
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted > 0;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION trestle_record_integration_event(text, text, text, text, text, text, text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trestle_record_integration_event(text, text, text, text, text, text, text, text, text) TO trestle_app;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY "integration_provider_event_recorder" ON "integration_provider_event" FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  END IF;
END
$$;
