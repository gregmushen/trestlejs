-- Outbox provenance retention's database role: NOLOGIN, no RLS bypass. No login
-- is left a member of it; its access is reachable only through the two
-- SECURITY DEFINER functions below, which it owns.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trestle_retention') THEN
    CREATE ROLE trestle_retention NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint
CREATE INDEX "webhook_message_source_event_idx" ON "webhook_message" USING btree ("source_event_id");--> statement-breakpoint
CREATE POLICY "webhook_delivery_retention_select" ON "webhook_delivery" AS PERMISSIVE FOR SELECT TO "trestle_retention" USING (true);--> statement-breakpoint
CREATE POLICY "webhook_message_retention_select" ON "webhook_message" AS PERMISSIVE FOR SELECT TO "trestle_retention" USING (true);--> statement-breakpoint
-- Exactly the columns the retention checks read, plus DELETE on the outbox.
-- webhook_message.envelope and outbox_message.payload are never granted.
GRANT USAGE ON SCHEMA public TO trestle_retention;--> statement-breakpoint
GRANT SELECT ("id", "status", "processed_at") ON "outbox_message" TO trestle_retention;--> statement-breakpoint
GRANT DELETE ON "outbox_message" TO trestle_retention;--> statement-breakpoint
GRANT SELECT ("event_id", "status", "leased_until", "created_at") ON "event_inbox" TO trestle_retention;--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "source_event_id") ON "webhook_message" TO trestle_retention;--> statement-breakpoint
GRANT SELECT ("message_id", "organization_id", "state") ON "webhook_delivery" TO trestle_retention;--> statement-breakpoint
-- Outbox provenance retention. A succeeded outbox row is the committed record a
-- queued, retried, or replayed handler verifies against, so pruning skips rows
-- that in-progress work still references:
--   * an inbox claim still 'processing' whose lease was taken or released within
--     the 14-day replay window (EVENT_REPLAY_WINDOW_DAYS). Released claims stay
--     'processing' forever, so the window bounds the protection;
--   * a webhook projection with a delivery that is not yet terminal, in any tenant.
--     Event IDs are UUIDs; comparing as uuid (not source_event_id::text) keeps
--     webhook_message_source_event_idx usable, and a non-UUID ID matches nothing.
-- webhook_message and webhook_delivery force RLS keyed on app.organization_id,
-- and the pruning connection has no tenant. The functions run as their owner,
-- trestle_retention, whose SELECT policies above see every tenant's rows; they
-- return only a count. The search path excludes public and every relation is
-- schema-qualified. The 30-day cutoff floor (EVENT_PROVENANCE_RETENTION_DAYS) is
-- enforced by the caller.
CREATE FUNCTION public.trestle_count_prunable_outbox_provenance(p_before timestamptz)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_before IS NULL OR NOT isfinite(p_before) THEN
    RAISE EXCEPTION 'Invalid outbox retention cutoff' USING ERRCODE = '22023';
  END IF;
  SELECT count(*)::integer INTO v_count
    FROM public.outbox_message o
   WHERE o.status = 'succeeded'
     AND o.processed_at < p_before
     AND NOT EXISTS (
       SELECT 1 FROM public.event_inbox i
        WHERE i.event_id = o.id AND i.status = 'processing'
          AND coalesce(i.leased_until, i.created_at) > now() - interval '14 days')
     AND NOT EXISTS (
       SELECT 1 FROM public.webhook_message m
         JOIN public.webhook_delivery d ON d.message_id = m.id AND d.organization_id = m.organization_id
        WHERE m.source_event_id = (CASE WHEN o.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN o.id::uuid END)
          AND d.state IN ('pending', 'leased', 'retry'));
  RETURN v_count;
END
$$;--> statement-breakpoint
-- trestle_retention holds no UPDATE privilege, so candidates are not locked
-- with FOR UPDATE. The DELETE rechecks status and age on the target row, and a
-- concurrent prune waits on, then skips, rows another prune deleted.
CREATE FUNCTION public.trestle_prune_outbox_provenance(p_before timestamptz, p_max_rows integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_before IS NULL OR NOT isfinite(p_before) THEN
    RAISE EXCEPTION 'Invalid outbox retention cutoff' USING ERRCODE = '22023';
  END IF;
  IF p_max_rows IS NULL OR p_max_rows < 1 OR p_max_rows > 10000 THEN
    RAISE EXCEPTION 'Invalid outbox retention limit' USING ERRCODE = '22023';
  END IF;
  WITH candidates AS (
    SELECT o.id FROM public.outbox_message o
     WHERE o.status = 'succeeded'
       AND o.processed_at < p_before
       AND NOT EXISTS (
         SELECT 1 FROM public.event_inbox i
          WHERE i.event_id = o.id AND i.status = 'processing'
            AND coalesce(i.leased_until, i.created_at) > now() - interval '14 days')
       AND NOT EXISTS (
         SELECT 1 FROM public.webhook_message m
           JOIN public.webhook_delivery d ON d.message_id = m.id AND d.organization_id = m.organization_id
          WHERE m.source_event_id = (CASE WHEN o.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN o.id::uuid END)
            AND d.state IN ('pending', 'leased', 'retry'))
     ORDER BY o.processed_at, o.id
     LIMIT p_max_rows
  )
  DELETE FROM public.outbox_message o USING candidates c
   WHERE o.id = c.id AND o.status = 'succeeded' AND o.processed_at < p_before;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.trestle_count_prunable_outbox_provenance(timestamptz) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.trestle_prune_outbox_provenance(timestamptz, integer) FROM PUBLIC;--> statement-breakpoint
-- Hand the functions to trestle_retention. A non-superuser migration role (for
-- example Neon's database owner) must be able to SET ROLE to the new owner,
-- which must hold CREATE on the schema. Both are granted only for the transfer
-- and revoked again, so the migration role never inherits the retention
-- policies. On PostgreSQL 16+ the role's creator keeps the ADMIN option it was
-- given at CREATE ROLE, without INHERIT or SET. A later migration that replaces
-- these functions repeats this grant, transfer, and revoke. The migration role,
-- which runs `trestle queue prune`, is the only caller allowed to execute them.
DO $$
DECLARE
  v_superuser boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper);
BEGIN
  IF NOT v_superuser THEN
    EXECUTE format('GRANT trestle_retention TO %I', current_user);
  END IF;
  GRANT CREATE ON SCHEMA public TO trestle_retention;
  ALTER FUNCTION public.trestle_count_prunable_outbox_provenance(timestamptz) OWNER TO trestle_retention;
  ALTER FUNCTION public.trestle_prune_outbox_provenance(timestamptz, integer) OWNER TO trestle_retention;
  REVOKE CREATE ON SCHEMA public FROM trestle_retention;
  IF NOT v_superuser THEN
    EXECUTE format('REVOKE trestle_retention FROM %I', current_user);
  END IF;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.trestle_count_prunable_outbox_provenance(timestamptz) TO %I', current_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.trestle_prune_outbox_provenance(timestamptz, integer) TO %I', current_user);
END
$$;
