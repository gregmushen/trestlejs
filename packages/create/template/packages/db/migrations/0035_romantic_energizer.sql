-- Platform webhook replay's database role: NOLOGIN, no RLS bypass. No login is
-- left a member of it; its access is reachable only through
-- trestle_replay_webhook_delivery, which it owns from here on. It replaces the
-- unrestricted "*_replay_owner" policies migration 0028 gave a migration role
-- without BYPASSRLS, which also let that login, where it doubles as the runtime
-- DATABASE_URL, read and write every tenant's webhook rows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trestle_webhook_replay') THEN
    CREATE ROLE trestle_webhook_replay NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint
CREATE INDEX "webhook_delivery_message_idx" ON "webhook_delivery" USING btree ("message_id");--> statement-breakpoint
CREATE POLICY "audit_event_replay_insert" ON "audit_event" AS PERMISSIVE FOR INSERT TO "trestle_webhook_replay" WITH CHECK ("audit_event"."name" = 'platform.webhook_delivery.replayed' AND "audit_event"."target_type" = 'webhook_delivery' AND "audit_event"."organization_id" IS NOT NULL);--> statement-breakpoint
CREATE POLICY "webhook_delivery_replay_select" ON "webhook_delivery" AS PERMISSIVE FOR SELECT TO "trestle_webhook_replay" USING (true);--> statement-breakpoint
CREATE POLICY "webhook_delivery_replay_lock" ON "webhook_delivery" AS PERMISSIVE FOR UPDATE TO "trestle_webhook_replay" USING (true) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "webhook_delivery_replay_insert" ON "webhook_delivery" AS PERMISSIVE FOR INSERT TO "trestle_webhook_replay" WITH CHECK ("webhook_delivery"."replay_of_delivery_id" IS NOT NULL AND "webhook_delivery"."state" = 'pending' AND "webhook_delivery"."attempt_count" = 0);--> statement-breakpoint
CREATE POLICY "webhook_message_replay_select" ON "webhook_message" AS PERMISSIVE FOR SELECT TO "trestle_webhook_replay" USING ("webhook_message"."status" = 'ready' AND "webhook_message"."payload_deleted_at" IS NULL AND "webhook_message"."envelope" IS NOT NULL);--> statement-breakpoint
CREATE POLICY "webhook_endpoint_replay_select" ON "webhook_endpoint" AS PERMISSIVE FOR SELECT TO "trestle_webhook_replay" USING ("webhook_endpoint"."state" = 'active' AND "webhook_endpoint"."deleted_at" IS NULL);--> statement-breakpoint
-- 0028 created these only for a migration role without BYPASSRLS or superuser;
-- the replay function no longer runs as that role. audit_event_security_owner
-- (0032) still covers trestle_record_security_event for such a role.
DROP POLICY IF EXISTS "webhook_delivery_replay_owner" ON "webhook_delivery";--> statement-breakpoint
DROP POLICY IF EXISTS "webhook_message_replay_owner" ON "webhook_message";--> statement-breakpoint
DROP POLICY IF EXISTS "webhook_endpoint_replay_owner" ON "webhook_endpoint";--> statement-breakpoint
DROP POLICY IF EXISTS "audit_event_replay_owner" ON "audit_event";--> statement-breakpoint
-- Exactly the columns replay reads and writes. webhook_message.envelope,
-- outbox_message.payload, webhook_endpoint.destination_url, and
-- webhook_delivery.lease_token are never granted. Row locks (FOR UPDATE on the
-- source delivery, FOR SHARE on its provenance) require UPDATE on one column;
-- the function never updates, and the delivery lock policy's WITH CHECK (false)
-- refuses any update. No DELETE anywhere.
GRANT USAGE ON SCHEMA public TO trestle_webhook_replay;--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "message_id", "endpoint_id", "replay_of_delivery_id", "state", "attempt_count") ON "webhook_delivery" TO trestle_webhook_replay;--> statement-breakpoint
GRANT UPDATE ("terminal_reason") ON "webhook_delivery" TO trestle_webhook_replay;--> statement-breakpoint
GRANT INSERT ("id", "organization_id", "message_id", "endpoint_id", "replay_of_delivery_id", "state", "next_attempt_at", "attempt_count", "created_at") ON "webhook_delivery" TO trestle_webhook_replay;--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "status", "payload_deleted_at", "source_event_id") ON "webhook_message" TO trestle_webhook_replay;--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "state", "deleted_at") ON "webhook_endpoint" TO trestle_webhook_replay;--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "occurred_at") ON "outbox_message" TO trestle_webhook_replay;--> statement-breakpoint
GRANT UPDATE ("last_error") ON "outbox_message" TO trestle_webhook_replay;--> statement-breakpoint
GRANT INSERT ("occurred_at", "name", "schema_version", "actor_type", "actor_id", "organization_id", "target_type", "target_id", "reason", "summary", "outcome", "environment", "correlation_id") ON "audit_event" TO trestle_webhook_replay;--> statement-breakpoint
-- The platform delivery list reports replay eligibility from the source event's
-- age, which needs the event ID (never the envelope). trestle_platform already
-- reads outbox_message (id, organization_id, occurred_at).
GRANT SELECT ("source_event_id") ON "webhook_message" TO trestle_platform;--> statement-breakpoint
-- Unchanged from 0033 except that it reads only granted columns: the source row
-- is locked by explicit columns rather than %ROWTYPE, and the retained-envelope
-- test moved into webhook_message_replay_select, so a message without one is
-- invisible here and reported as 'payload_gone'. CREATE OR REPLACE keeps the
-- EXECUTE grant to trestle_platform, and so does the ownership transfer below.
CREATE OR REPLACE FUNCTION public.trestle_replay_webhook_delivery(p_organization_id text, p_delivery_id text, p_now timestamp with time zone, p_actor_type text, p_actor_id text, p_reason text, p_environment text, p_correlation_id text)
RETURNS TABLE (result text, delivery_id text, previous_state text, previous_attempt_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_source record;
  v_root_id text;
  v_existing_id text;
  v_new_id text;
  v_message_found boolean;
  v_message_status text;
  v_payload_deleted_at timestamp with time zone;
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
  SELECT d.id, d.message_id, d.endpoint_id, d.replay_of_delivery_id, d.state, d.attempt_count INTO v_source
    FROM public.webhook_delivery d
   WHERE d.id = p_delivery_id AND d.organization_id = p_organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::integer;
    RETURN;
  END IF;
  IF v_source.state NOT IN ('dead', 'exhausted') THEN
    RETURN QUERY SELECT 'not_terminal'::text, NULL::text, v_source.state::text, v_source.attempt_count::integer;
    RETURN;
  END IF;
  SELECT true, m.status, m.payload_deleted_at, m.source_event_id
    INTO v_message_found, v_message_status, v_payload_deleted_at, v_source_event_id
    FROM public.webhook_message m
   WHERE m.id = v_source.message_id AND m.organization_id = p_organization_id;
  IF NOT coalesce(v_message_found, false) OR v_message_status IS DISTINCT FROM 'ready' OR v_payload_deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT 'payload_gone'::text, NULL::text, v_source.state::text, v_source.attempt_count::integer;
    RETURN;
  END IF;
  SELECT e.state, e.deleted_at INTO v_endpoint_state, v_endpoint_deleted_at
    FROM public.webhook_endpoint e
   WHERE e.id = v_source.endpoint_id AND e.organization_id = p_organization_id;
  IF v_endpoint_state IS DISTINCT FROM 'active' OR v_endpoint_deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT 'endpoint_inactive'::text, NULL::text, v_source.state::text, v_source.attempt_count::integer;
    RETURN;
  END IF;
  v_root_id := coalesce(v_source.replay_of_delivery_id, v_source.id);
  SELECT d.id INTO v_existing_id
    FROM public.webhook_delivery d
   WHERE d.replay_of_delivery_id = v_root_id AND d.state = 'succeeded'
   LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT 'already_succeeded'::text, v_existing_id, v_source.state::text, v_source.attempt_count::integer;
    RETURN;
  END IF;
  SELECT d.id INTO v_existing_id
    FROM public.webhook_delivery d
   WHERE d.replay_of_delivery_id = v_root_id AND d.state IN ('pending', 'leased', 'retry')
   LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT 'existing'::text, v_existing_id, v_source.state::text, v_source.attempt_count::integer;
    RETURN;
  END IF;
  -- FOR SHARE holds the provenance until commit; the new non-terminal
  -- delivery then keeps it from being pruned.
  SELECT o.occurred_at INTO v_occurred_at
    FROM public.outbox_message o
   WHERE o.id = v_source_event_id::text AND o.organization_id = p_organization_id
   FOR SHARE;
  IF v_occurred_at IS NULL OR v_occurred_at < now() - interval '14 days' THEN
    RETURN QUERY SELECT 'provenance_expired'::text, NULL::text, v_source.state::text, v_source.attempt_count::integer;
    RETURN;
  END IF;
  v_new_id := 'whd_replay_' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.webhook_delivery (id, organization_id, message_id, endpoint_id, replay_of_delivery_id, state, next_attempt_at, attempt_count, created_at)
  VALUES (v_new_id, p_organization_id, v_source.message_id, v_source.endpoint_id, v_root_id, 'pending', coalesce(p_now, now()), 0, coalesce(p_now, now()));
  INSERT INTO public.audit_event (occurred_at, name, schema_version, actor_type, actor_id, organization_id, target_type, target_id, reason, summary, outcome, environment, correlation_id)
  VALUES (coalesce(p_now, now()), 'platform.webhook_delivery.replayed', '1', p_actor_type, p_actor_id, p_organization_id, 'webhook_delivery', v_new_id, trim(p_reason),
    jsonb_build_object('sourceDeliveryId', p_delivery_id, 'previousState', v_source.state, 'previousAttemptCount', v_source.attempt_count),
    'succeeded', p_environment, p_correlation_id);
  RETURN QUERY SELECT 'created'::text, v_new_id, v_source.state::text, v_source.attempt_count::integer;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.trestle_replay_webhook_delivery(text, text, timestamp with time zone, text, text, text, text, text) FROM PUBLIC;--> statement-breakpoint
-- Hand the function to trestle_webhook_replay, as 0033 does for retention. A
-- non-superuser migration role (for example Neon's database owner) must be able
-- to SET ROLE to the new owner, which must hold CREATE on the schema. Both are
-- granted only for the transfer and revoked again, so the migration role never
-- inherits the replay policies. On PostgreSQL 16+ the role's creator keeps the
-- ADMIN option it was given at CREATE ROLE, without INHERIT or SET. The EXECUTE
-- grant to trestle_platform survives the transfer; the migration role, no
-- longer the owner, loses EXECUTE. Nothing is granted after the membership is
-- revoked, when the migration role could no longer grant on the function.
DO $$
DECLARE
  v_superuser boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper);
BEGIN
  IF NOT v_superuser THEN
    EXECUTE format('GRANT trestle_webhook_replay TO %I', current_user);
  END IF;
  GRANT CREATE ON SCHEMA public TO trestle_webhook_replay;
  ALTER FUNCTION public.trestle_replay_webhook_delivery(text, text, timestamp with time zone, text, text, text, text, text) OWNER TO trestle_webhook_replay;
  REVOKE CREATE ON SCHEMA public FROM trestle_webhook_replay;
  IF NOT v_superuser THEN
    EXECUTE format('REVOKE trestle_webhook_replay FROM %I', current_user);
  END IF;
END
$$;
