ALTER TABLE "job_runtime_config" ADD COLUMN "declared_available" text[];--> statement-breakpoint
ALTER TABLE "job_runtime_config" ADD COLUMN "declared_credentials" jsonb;--> statement-breakpoint
ALTER TABLE "job_runtime_config" ADD COLUMN "switched_from" text;--> statement-breakpoint
ALTER TABLE "job_runtime_config" ADD COLUMN "switched_at" timestamp with time zone;--> statement-breakpoint
CREATE POLICY "job_runtime_config_platform_override" ON "job_runtime_config" AS PERMISSIVE FOR UPDATE TO "trestle_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
-- The customer Worker also declares which runtimes it has installed and which of their
-- credentials are set (presence only), and reads the admin override to choose its dispatch target.
GRANT SELECT ("declared_available", "declared_credentials", "override_runtime", "override_hosting", "override_endpoint", "override_project", "override_settings", "override_version") ON "job_runtime_config" TO trestle_app;--> statement-breakpoint
GRANT INSERT ("declared_available", "declared_credentials") ON "job_runtime_config" TO trestle_app;--> statement-breakpoint
GRANT UPDATE ("declared_available", "declared_credentials") ON "job_runtime_config" TO trestle_app;--> statement-breakpoint
-- Platform admin writes only the override and switch columns; the declared_* columns stay the Worker's.
GRANT UPDATE ("override_runtime", "override_hosting", "override_endpoint", "override_project", "override_settings", "override_version", "overridden_by", "overridden_at", "switched_from", "switched_at") ON "job_runtime_config" TO trestle_platform;--> statement-breakpoint
-- "Settle now" from the admin Jobs view: the same transition as PostgresOutboxStore.settleUnconsumed.
-- Dispatched rows no consumer completed inside the replay window are dead-lettered at the attempt
-- cap and returned to pending otherwise, each bounded by p_limit. The platform role never reads
-- event_inbox or payloads; it gets only the two counts. outbox_message and event_inbox have no
-- RLS, so the owner needs no resolver policy.
CREATE OR REPLACE FUNCTION public.trestle_settle_unconsumed_jobs(p_older_than_ms bigint, p_max_attempts integer, p_limit integer)
RETURNS TABLE (dead_lettered integer, requeued integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_dead integer;
  v_requeued integer;
BEGIN
  IF p_older_than_ms IS NULL OR p_older_than_ms < 0 OR p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 5 OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid settlement parameters' USING ERRCODE = '22023';
  END IF;
  WITH capped AS (
    SELECT o.id FROM public.outbox_message o
    WHERE o.status = 'succeeded' AND o.processed_at <= pg_catalog.now() - (p_older_than_ms * interval '1 millisecond')
      AND o.occurred_at > pg_catalog.now() - interval '14 days' AND o.attempts + 1 >= p_max_attempts
      AND NOT EXISTS (SELECT 1 FROM public.event_inbox i WHERE i.idempotency_key = o.idempotency_key AND i.status = 'completed')
    ORDER BY o.processed_at
    FOR UPDATE OF o SKIP LOCKED LIMIT p_limit
  )
  UPDATE public.outbox_message m SET status = 'dead', last_error = 'unconsumed_after_retries' FROM capped WHERE m.id = capped.id;
  GET DIAGNOSTICS v_dead = ROW_COUNT;
  WITH stale AS (
    SELECT o.id FROM public.outbox_message o
    WHERE o.status = 'succeeded' AND o.processed_at <= pg_catalog.now() - (p_older_than_ms * interval '1 millisecond')
      AND o.occurred_at > pg_catalog.now() - interval '14 days' AND o.attempts + 1 < p_max_attempts
      AND NOT EXISTS (SELECT 1 FROM public.event_inbox i WHERE i.idempotency_key = o.idempotency_key AND i.status = 'completed')
    ORDER BY o.processed_at
    FOR UPDATE OF o SKIP LOCKED LIMIT p_limit
  )
  UPDATE public.outbox_message m SET status = 'pending', available_at = pg_catalog.now(), attempts = m.attempts + 1, processed_at = NULL FROM stale WHERE m.id = stale.id;
  GET DIAGNOSTICS v_requeued = ROW_COUNT;
  RETURN QUERY SELECT v_dead, v_requeued;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.trestle_settle_unconsumed_jobs(bigint, integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.trestle_settle_unconsumed_jobs(bigint, integer, integer) TO trestle_platform;
