CREATE TABLE "job_runtime_config" (
	"environment" text PRIMARY KEY NOT NULL,
	"declared_runtime" text NOT NULL,
	"declared_hosting" text NOT NULL,
	"declared_endpoint" text,
	"declared_project" text,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"override_runtime" text,
	"override_hosting" text,
	"override_endpoint" text,
	"override_project" text,
	"override_settings" jsonb,
	"override_version" integer DEFAULT 0 NOT NULL,
	"overridden_by" text,
	"overridden_at" timestamp with time zone,
	CONSTRAINT "job_runtime_config_declared_runtime_check" CHECK ("job_runtime_config"."declared_runtime" IN ('cloudflare', 'trigger', 'inngest')),
	CONSTRAINT "job_runtime_config_declared_hosting_check" CHECK ("job_runtime_config"."declared_hosting" IN ('cloud', 'self-hosted', 'cloudflare')),
	CONSTRAINT "job_runtime_config_override_runtime_check" CHECK ("job_runtime_config"."override_runtime" IS NULL OR "job_runtime_config"."override_runtime" IN ('cloudflare', 'trigger', 'inngest')),
	CONSTRAINT "job_runtime_config_override_hosting_check" CHECK ("job_runtime_config"."override_hosting" IS NULL OR "job_runtime_config"."override_hosting" IN ('cloud', 'self-hosted', 'cloudflare'))
);
--> statement-breakpoint
ALTER TABLE "job_runtime_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "job_runtime_config_app_declare" ON "job_runtime_config" AS PERMISSIVE FOR ALL TO "trestle_app" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "job_runtime_config_platform_select" ON "job_runtime_config" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
-- The customer Worker declares its deploy-time job runtime; it never writes the override_* columns.
GRANT SELECT ("environment", "declared_runtime", "declared_hosting", "declared_endpoint", "declared_project", "declared_at") ON "job_runtime_config" TO trestle_app;--> statement-breakpoint
GRANT INSERT ("environment", "declared_runtime", "declared_hosting", "declared_endpoint", "declared_project", "declared_at") ON "job_runtime_config" TO trestle_app;--> statement-breakpoint
GRANT UPDATE ("declared_runtime", "declared_hosting", "declared_endpoint", "declared_project", "declared_at") ON "job_runtime_config" TO trestle_app;--> statement-breakpoint
-- Platform admin reads the effective runtime; Phase 1 is read-only.
GRANT SELECT ON "job_runtime_config" TO trestle_platform;--> statement-breakpoint
-- Dispatch health for the admin Jobs view: the same three counts as `trestle jobs
-- migrate`. The platform role never reads event_inbox, so it gets only these totals.
-- outbox_message and event_inbox have no RLS, so the owner needs no resolver policy.
CREATE OR REPLACE FUNCTION public.trestle_job_dispatch_health()
RETURNS TABLE (pending integer, unconsumed integer, dead integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    count(*) FILTER (WHERE o.status IN ('pending', 'leased'))::integer,
    count(*) FILTER (WHERE o.status = 'succeeded' AND o.occurred_at > now() - interval '14 days' AND NOT EXISTS (SELECT 1 FROM public.event_inbox i WHERE i.idempotency_key = o.idempotency_key AND i.status = 'completed'))::integer,
    count(*) FILTER (WHERE o.status = 'dead')::integer
  FROM public.outbox_message o
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.trestle_job_dispatch_health() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.trestle_job_dispatch_health() TO trestle_platform;
