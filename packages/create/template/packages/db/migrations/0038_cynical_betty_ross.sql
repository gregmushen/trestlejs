CREATE TABLE "integration_authorization_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"environment" text NOT NULL,
	"backend" text NOT NULL,
	"provider_config_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"initiated_by" text NOT NULL,
	"connection_id" uuid,
	"failure_category" text,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_authorization_attempt_status_check" CHECK ("integration_authorization_attempt"."status" IN ('pending', 'completed', 'failed')),
	CONSTRAINT "integration_authorization_attempt_backend_check" CHECK ("integration_authorization_attempt"."backend" IN ('local', 'nango'))
);
--> statement-breakpoint
ALTER TABLE "integration_authorization_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integration_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"environment" text NOT NULL,
	"backend" text NOT NULL,
	"provider_config_key" text NOT NULL,
	"backend_connection_id" text NOT NULL,
	"provider" text,
	"state" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"cleanup_pending" text,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"connected_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connection_state_check" CHECK ("integration_connection"."state" IN ('disconnected', 'authorizing', 'connected', 'degraded', 'reauthorization_required', 'revoked')),
	CONSTRAINT "integration_connection_backend_check" CHECK ("integration_connection"."backend" IN ('local', 'nango')),
	CONSTRAINT "integration_connection_generation_check" CHECK ("integration_connection"."generation" >= 1),
	CONSTRAINT "integration_connection_cleanup_check" CHECK ("integration_connection"."cleanup_pending" IS NULL OR "integration_connection"."cleanup_pending" IN ('backend_delete'))
);
--> statement-breakpoint
ALTER TABLE "integration_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "integration_authorization_attempt_organization_idx" ON "integration_authorization_attempt" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connection_backend_ref_uidx" ON "integration_connection" USING btree ("backend","environment","provider_config_key","backend_connection_id");--> statement-breakpoint
CREATE INDEX "integration_connection_organization_idx" ON "integration_connection" USING btree ("organization_id","environment");--> statement-breakpoint
CREATE POLICY "integration_authorization_attempt_tenant" ON "integration_authorization_attempt" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("integration_authorization_attempt"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("integration_authorization_attempt"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "integration_connection_tenant" ON "integration_connection" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("integration_connection"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("integration_connection"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "integration_connection_platform_select" ON "integration_connection" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
ALTER TABLE "integration_connection" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_authorization_attempt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "integration_connection" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON "integration_authorization_attempt" FROM PUBLIC;--> statement-breakpoint
-- Connections are revoked, never deleted, so their audit trail keeps a target.
GRANT SELECT, INSERT, UPDATE ON "integration_connection" TO trestle_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "integration_authorization_attempt" TO trestle_app;--> statement-breakpoint
-- The platform admin lists Connection metadata across tenants; attempts stay tenant-only.
GRANT SELECT ON "integration_connection" TO trestle_platform;--> statement-breakpoint
-- A verified connection-backend callback carries only the attempt ID (a tag the backend echoes).
-- The resolver returns the persisted binding; the tag's organization is never trusted.
CREATE OR REPLACE FUNCTION trestle_resolve_integration_attempt(p_attempt_id uuid)
RETURNS TABLE (organization_id text, environment text, backend text, provider_config_key text, status text, expires_at timestamp with time zone)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a.organization_id, a.environment, a.backend, a.provider_config_key, a.status, a.expires_at
    FROM public.integration_authorization_attempt a
   WHERE a.id = p_attempt_id
   LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION trestle_resolve_integration_attempt(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trestle_resolve_integration_attempt(uuid) TO trestle_app;--> statement-breakpoint
-- Callbacks about an existing Connection (refresh failure) resolve it by its backend reference.
CREATE OR REPLACE FUNCTION trestle_resolve_integration_connection(p_backend text, p_environment text, p_provider_config_key text, p_backend_connection_id text)
RETURNS TABLE (organization_id text, id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.organization_id, c.id
    FROM public.integration_connection c
   WHERE c.backend = p_backend AND c.environment = p_environment AND c.provider_config_key = p_provider_config_key AND c.backend_connection_id = p_backend_connection_id
   LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION trestle_resolve_integration_connection(text, text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trestle_resolve_integration_connection(text, text, text, text) TO trestle_app;--> statement-breakpoint
-- Forced RLS applies to the table owner that runs the resolvers, so give the owner a read policy
-- unless it already bypasses RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY "integration_authorization_attempt_resolver" ON "integration_authorization_attempt" FOR SELECT TO %I USING (true)', current_user);
    EXECUTE format('CREATE POLICY "integration_connection_resolver" ON "integration_connection" FOR SELECT TO %I USING (true)', current_user);
  END IF;
END
$$;
