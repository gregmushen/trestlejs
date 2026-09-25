CREATE INDEX "webhook_message_source_event_idx" ON "webhook_message" USING btree ("source_event_id");--> statement-breakpoint
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
-- and the pruning connection has no tenant. SECURITY DEFINER lets the check see
-- every tenant's rows as the migration owner; the functions return only a count.
-- The 30-day cutoff floor (EVENT_PROVENANCE_RETENTION_DAYS) is enforced by the caller.
-- Executable only by the owner (the migration role, which runs `trestle queue prune`).
CREATE FUNCTION trestle_count_prunable_outbox_provenance(p_before timestamptz)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
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
CREATE FUNCTION trestle_prune_outbox_provenance(p_before timestamptz, p_max_rows integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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
     FOR UPDATE OF o SKIP LOCKED
  )
  DELETE FROM public.outbox_message o USING candidates c WHERE o.id = c.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION trestle_count_prunable_outbox_provenance(timestamptz) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION trestle_prune_outbox_provenance(timestamptz, integer) FROM PUBLIC;--> statement-breakpoint
-- FORCE RLS also applies to a non-BYPASSRLS migration owner running these
-- SECURITY DEFINER functions. Such an owner already controls this schema.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY "webhook_message_provenance_owner" ON "webhook_message" FOR SELECT TO %I USING (true)', current_user);
    EXECUTE format('CREATE POLICY "webhook_delivery_provenance_owner" ON "webhook_delivery" FOR SELECT TO %I USING (true)', current_user);
  END IF;
END
$$;
