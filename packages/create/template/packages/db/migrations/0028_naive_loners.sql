DROP INDEX "webhook_delivery_message_endpoint_uidx";--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD COLUMN "replay_of_delivery_id" text;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_replay_tenant_fk" FOREIGN KEY ("replay_of_delivery_id","organization_id") REFERENCES "public"."webhook_delivery"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_delivery_active_replay_uidx" ON "webhook_delivery" USING btree ("replay_of_delivery_id") WHERE "webhook_delivery"."replay_of_delivery_id" IS NOT NULL AND "webhook_delivery"."state" IN ('pending', 'leased', 'retry');--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_delivery_message_endpoint_uidx" ON "webhook_delivery" USING btree ("message_id","endpoint_id") WHERE "webhook_delivery"."replay_of_delivery_id" IS NULL;--> statement-breakpoint
DROP POLICY "webhook_delivery_platform_replay" ON "webhook_delivery";--> statement-breakpoint
REVOKE UPDATE ("state", "next_attempt_at", "terminal_reason", "completed_at") ON "webhook_delivery" FROM trestle_platform;--> statement-breakpoint
GRANT SELECT ("replay_of_delivery_id") ON "webhook_delivery" TO trestle_platform;--> statement-breakpoint
-- The platform role has no INSERT/UPDATE on tenant deliveries. This function
-- creates only a fresh execution of the same retained message for an active
-- endpoint, and serializes concurrent replay requests on the original row.
CREATE FUNCTION trestle_replay_webhook_delivery(p_organization_id text, p_delivery_id text, p_now timestamp with time zone, p_actor_type text, p_actor_id text, p_reason text, p_environment text, p_correlation_id text)
RETURNS TABLE (result text, delivery_id text, previous_state text, previous_attempt_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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
  SELECT m.status, m.payload_deleted_at, m.envelope IS NOT NULL
    INTO v_message_status, v_payload_deleted_at, v_payload_present
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
  v_new_id := 'whd_replay_' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.webhook_delivery (id, organization_id, message_id, endpoint_id, replay_of_delivery_id, state, next_attempt_at, attempt_count, created_at)
  VALUES (v_new_id, p_organization_id, v_source.message_id, v_source.endpoint_id, v_root_id, 'pending', coalesce(p_now, now()), 0, coalesce(p_now, now()));
  INSERT INTO public.audit_event (occurred_at, name, schema_version, actor_type, actor_id, organization_id, target_type, target_id, reason, summary, outcome, environment, correlation_id)
  VALUES (coalesce(p_now, now()), 'platform.webhook_delivery.replayed', '1', p_actor_type, p_actor_id, p_organization_id, 'webhook_delivery', v_new_id, trim(p_reason),
    jsonb_build_object('sourceDeliveryId', p_delivery_id, 'previousState', v_source.state, 'previousAttemptCount', v_source.attempt_count),
    'succeeded', p_environment, p_correlation_id);
  RETURN QUERY SELECT 'created'::text, v_new_id, v_source.state, v_source.attempt_count;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION trestle_replay_webhook_delivery(text, text, timestamp with time zone, text, text, text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trestle_replay_webhook_delivery(text, text, timestamp with time zone, text, text, text, text, text) TO trestle_platform;--> statement-breakpoint
-- FORCE RLS also applies to a non-BYPASSRLS migration owner running the
-- SECURITY DEFINER function. Such an owner already controls this schema.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY "webhook_delivery_replay_owner" ON "webhook_delivery" FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
    EXECUTE format('CREATE POLICY "webhook_message_replay_owner" ON "webhook_message" FOR SELECT TO %I USING (true)', current_user);
    EXECUTE format('CREATE POLICY "webhook_endpoint_replay_owner" ON "webhook_endpoint" FOR SELECT TO %I USING (true)', current_user);
    EXECUTE format('CREATE POLICY "audit_event_replay_owner" ON "audit_event" FOR INSERT TO %I WITH CHECK (true)', current_user);
  END IF;
END
$$;
