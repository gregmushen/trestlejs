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
  -- Grant EXECUTE while the membership still lets a non-superuser act for the owner.
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.trestle_count_prunable_outbox_provenance(timestamptz) TO %I', current_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.trestle_prune_outbox_provenance(timestamptz, integer) TO %I', current_user);
  IF NOT v_superuser THEN
    EXECUTE format('REVOKE trestle_retention FROM %I', current_user);
  END IF;
END
$$;--> statement-breakpoint
-- A replayed delivery reverifies its committed source event, so platform replay
-- is refused ('provenance_expired') once the source outbox row is pruned,
-- belongs to another tenant, or is older than the 14-day replay window
-- (EVENT_REPLAY_WINDOW_DAYS), measured by the database clock rather than the
-- caller-supplied p_now. Otherwise unchanged from
-- 0028, except that the search path now excludes public. CREATE OR REPLACE
-- keeps the owner and the EXECUTE grant to trestle_platform.
CREATE OR REPLACE FUNCTION public.trestle_replay_webhook_delivery(p_organization_id text, p_delivery_id text, p_now timestamp with time zone, p_actor_type text, p_actor_id text, p_reason text, p_environment text, p_correlation_id text)
RETURNS TABLE (result text, delivery_id text, previous_state text, previous_attempt_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_source public.webhook_delivery%ROWTYPE;
  v_root_id text;
  v_existing_id text;
  v_new_id text;
  v_message_status text;
  v_payload_deleted_at timestamp with time zone;
  v_payload_present boolean;
  v_endpoint_state text;
  v_endpoint_deleted_at timestamp with time zone;
  v_source_event_id uuid;
  v_occurred_at timestamp with time zone;
BEGIN
  IF coalesce(p_actor_type, '') NOT IN ('platform_operator', 'system')
    OR nullif(trim(p_actor_id), '') IS NULL OR length(p_actor_id) > 500
    OR nullif(trim(p_reason), '') IS NULL OR length(p_reason) > 500
    OR coalesce(p_environment, '') NOT IN ('local', 'preview', 'staging', 'production')
    OR nullif(trim(p_correlation_id), '') IS NULL OR length(p_correlation_id) > 500 THEN
    RAISE EXCEPTION 'Invalid audited webhook replay context' USING ERRCODE = '22023';
  END IF;
  SELECT d.* INTO v_source
    FROM public.webhook_delivery d
   WHERE d.id = p_delivery_id AND d.organization_id = p_organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::integer;
    RETURN;
  END IF;
  IF v_source.state NOT IN ('dead', 'exhausted') THEN
    RETURN QUERY SELECT 'not_terminal'::text, NULL::text, v_source.state, v_source.attempt_count;
    RETURN;
  END IF;
  SELECT m.status, m.payload_deleted_at, m.envelope IS NOT NULL, m.source_event_id
    INTO v_message_status, v_payload_deleted_at, v_payload_present, v_source_event_id
    FROM public.webhook_message m
   WHERE m.id = v_source.message_id AND m.organization_id = p_organization_id;
  IF v_message_status IS DISTINCT FROM 'ready' OR v_payload_deleted_at IS NOT NULL OR NOT coalesce(v_payload_present, false) THEN
    RETURN QUERY SELECT 'payload_gone'::text, NULL::text, v_source.state, v_source.attempt_count;
    RETURN;
  END IF;
  SELECT e.state, e.deleted_at INTO v_endpoint_state, v_endpoint_deleted_at
    FROM public.webhook_endpoint e
   WHERE e.id = v_source.endpoint_id AND e.organization_id = p_organization_id;
  IF v_endpoint_state IS DISTINCT FROM 'active' OR v_endpoint_deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT 'endpoint_inactive'::text, NULL::text, v_source.state, v_source.attempt_count;
    RETURN;
  END IF;
  v_root_id := coalesce(v_source.replay_of_delivery_id, v_source.id);
  SELECT d.id INTO v_existing_id
    FROM public.webhook_delivery d
   WHERE d.replay_of_delivery_id = v_root_id AND d.state = 'succeeded'
   LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT 'already_succeeded'::text, v_existing_id, v_source.state, v_source.attempt_count;
    RETURN;
  END IF;
  SELECT d.id INTO v_existing_id
    FROM public.webhook_delivery d
   WHERE d.replay_of_delivery_id = v_root_id AND d.state IN ('pending', 'leased', 'retry')
   LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT 'existing'::text, v_existing_id, v_source.state, v_source.attempt_count;
    RETURN;
  END IF;
  -- FOR SHARE holds the provenance until commit; the new non-terminal
  -- delivery then keeps it from being pruned.
  SELECT o.occurred_at INTO v_occurred_at
    FROM public.outbox_message o
   WHERE o.id = v_source_event_id::text AND o.organization_id = p_organization_id
   FOR SHARE;
  IF v_occurred_at IS NULL OR v_occurred_at < now() - interval '14 days' THEN
    RETURN QUERY SELECT 'provenance_expired'::text, NULL::text, v_source.state, v_source.attempt_count;
    RETURN;
  END IF;
  v_new_id := 'whd_replay_' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.webhook_delivery (id, organization_id, message_id, endpoint_id, replay_of_delivery_id, state, next_attempt_at, attempt_count, created_at)
  VALUES (v_new_id, p_organization_id, v_source.message_id, v_source.endpoint_id, v_root_id, 'pending', coalesce(p_now, now()), 0, coalesce(p_now, now()));
  INSERT INTO public.audit_event (occurred_at, name, schema_version, actor_type, actor_id, organization_id, target_type, target_id, reason, summary, outcome, environment, correlation_id)
  VALUES (coalesce(p_now, now()), 'platform.webhook_delivery.replayed', '1', p_actor_type, p_actor_id, p_organization_id, 'webhook_delivery', v_new_id, trim(p_reason),
    jsonb_build_object('sourceDeliveryId', p_delivery_id, 'previousState', v_source.state, 'previousAttemptCount', v_source.attempt_count),
    'succeeded', p_environment, p_correlation_id);
  RETURN QUERY SELECT 'created'::text, v_new_id, v_source.state, v_source.attempt_count;
END
$$;
