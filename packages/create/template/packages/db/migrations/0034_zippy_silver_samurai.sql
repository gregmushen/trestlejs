CREATE TABLE "support_handoff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "support_handoff_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "support_handoff" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "support_view_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "support_view_grant_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "support_view_grant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "support_session" ADD COLUMN "target_user_id" text;--> statement-breakpoint
ALTER TABLE "support_handoff" ADD CONSTRAINT "support_handoff_session_id_support_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."support_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_view_grant" ADD CONSTRAINT "support_view_grant_session_id_support_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."support_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_handoff_session_idx" ON "support_handoff" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "support_view_grant_session_idx" ON "support_view_grant" USING btree ("session_id");--> statement-breakpoint
CREATE POLICY "support_handoff_platform_insert" ON "support_handoff" AS PERMISSIVE FOR INSERT TO "trestle_platform" WITH CHECK ("support_handoff"."consumed_at" IS NULL);--> statement-breakpoint
ALTER TABLE "support_handoff" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "support_view_grant" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "support_handoff", "support_view_grant" FROM PUBLIC;--> statement-breakpoint
GRANT INSERT ON "support_handoff" TO trestle_platform;--> statement-breakpoint
CREATE POLICY "support_handoff_platform_select" ON "support_handoff" FOR SELECT TO trestle_platform USING (true);--> statement-breakpoint
CREATE POLICY "support_handoff_platform_consume" ON "support_handoff" FOR UPDATE TO trestle_platform USING (consumed_at IS NULL) WITH CHECK (consumed_at IS NOT NULL);--> statement-breakpoint
CREATE POLICY "support_view_grant_platform" ON "support_view_grant" FOR ALL TO trestle_platform USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, UPDATE (consumed_at) ON "support_handoff" TO trestle_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (revoked_at) ON "support_view_grant" TO trestle_platform;--> statement-breakpoint
-- The application role has no table access. Narrow SECURITY DEFINER functions
-- alone may exchange and validate 256-bit opaque credentials.
CREATE FUNCTION public.trestle_consume_support_handoff(p_handoff_hash text, p_grant_hash text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_session_id uuid;
BEGIN
  IF p_handoff_hash !~ '^[0-9a-f]{64}$' OR p_grant_hash !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
  UPDATE public.support_handoff h SET consumed_at = now()
   WHERE h.token_hash = p_handoff_hash AND h.consumed_at IS NULL AND h.expires_at > now()
     AND EXISTS (
       SELECT 1 FROM public.support_session s
        WHERE s.id = h.session_id AND s.target_user_id IS NOT NULL
          AND s.ended_at IS NULL AND s.expires_at > now()
          AND EXISTS (SELECT 1 FROM public.member m WHERE m.organization_id = s.organization_id AND m.user_id = s.target_user_id)
          AND EXISTS (SELECT 1 FROM public.platform_role_assignment p WHERE p.user_id = s.operator_id AND p.role = 'platform_operator' AND p.revoked_at IS NULL)
     )
   RETURNING h.session_id INTO v_session_id;
  IF v_session_id IS NULL THEN RETURN false; END IF;
  INSERT INTO public.support_view_grant (session_id, token_hash) VALUES (v_session_id, p_grant_hash);
  RETURN true;
END
$$;--> statement-breakpoint
CREATE FUNCTION public.trestle_support_view(p_grant_hash text, p_path text, p_correlation_id text, p_environment text)
RETURNS TABLE(session_id uuid, organization_id text, organization_name text, operator_id text, operator_email text, viewed_user_id text, viewed_user_name text, viewed_user_email text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_grant_hash !~ '^[0-9a-f]{64}$' OR p_path IS NULL OR p_correlation_id IS NULL OR p_environment IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT s.id, s.organization_id, o.name, s.operator_id, op_user.email,
           s.target_user_id, viewed.name, viewed.email, s.expires_at
      FROM public.support_view_grant g
      JOIN public.support_session s ON s.id = g.session_id
      JOIN public.organization o ON o.id = s.organization_id
      JOIN public."user" op_user ON op_user.id = s.operator_id
      JOIN public."user" viewed ON viewed.id = s.target_user_id
     WHERE g.token_hash = p_grant_hash AND g.revoked_at IS NULL
       AND s.ended_at IS NULL AND s.expires_at > now()
       AND EXISTS (SELECT 1 FROM public.member m WHERE m.organization_id = s.organization_id AND m.user_id = s.target_user_id)
       AND EXISTS (SELECT 1 FROM public.platform_role_assignment p WHERE p.user_id = s.operator_id AND p.role = 'platform_operator' AND p.revoked_at IS NULL);
  IF FOUND THEN
    INSERT INTO public.audit_event (name, actor_type, actor_id, organization_id, target_type, target_id, reason, summary, outcome, environment, correlation_id, support_session_id)
    SELECT 'platform.support_view.accessed', 'platform_operator', s.operator_id, s.organization_id,
           'user', s.target_user_id, NULL, pg_catalog.jsonb_build_object('path', pg_catalog.left(p_path, 160)),
           'succeeded', pg_catalog.left(p_environment, 32), pg_catalog.left(p_correlation_id, 128), s.id::text
      FROM public.support_session s JOIN public.support_view_grant g ON g.session_id = s.id WHERE g.token_hash = p_grant_hash;
  END IF;
END
$$;--> statement-breakpoint
CREATE FUNCTION public.trestle_end_support_view(p_grant_hash text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_session_id uuid;
  v_operator_id text;
  v_organization_id text;
BEGIN
  IF p_grant_hash !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
  UPDATE public.support_view_grant SET revoked_at = now() WHERE token_hash = p_grant_hash AND revoked_at IS NULL RETURNING session_id INTO v_session_id;
  IF v_session_id IS NULL THEN RETURN false; END IF;
  UPDATE public.support_session s SET ended_at = now(), ended_by = 'platform_operator:' || s.operator_id
    WHERE s.id = v_session_id AND s.ended_at IS NULL
    RETURNING s.operator_id, s.organization_id INTO v_operator_id, v_organization_id;
  IF v_operator_id IS NOT NULL THEN
    INSERT INTO public.audit_event (name, actor_type, actor_id, organization_id, target_type, target_id, reason, summary, outcome, environment, correlation_id, support_session_id)
    VALUES ('platform.support_session.ended', 'platform_operator', v_operator_id, v_organization_id,
      'support_session', v_session_id::text, 'Operator exited from customer app', '{}'::jsonb, 'succeeded',
      'support_view', pg_catalog.gen_random_uuid()::text, v_session_id::text);
  END IF;
  RETURN true;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.trestle_consume_support_handoff(text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.trestle_support_view(text, text, text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.trestle_end_support_view(text) FROM PUBLIC;--> statement-breakpoint
-- The definer is the restricted platform role, not the migration owner. It has
-- no tenant-app login and no BYPASSRLS; the exact policies/grants above bound it.
DO $$
DECLARE
  v_superuser boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper);
BEGIN
  IF NOT v_superuser THEN EXECUTE format('GRANT trestle_platform TO %I', current_user); END IF;
  GRANT CREATE ON SCHEMA public TO trestle_platform;
  ALTER FUNCTION public.trestle_consume_support_handoff(text, text) OWNER TO trestle_platform;
  ALTER FUNCTION public.trestle_support_view(text, text, text, text) OWNER TO trestle_platform;
  ALTER FUNCTION public.trestle_end_support_view(text) OWNER TO trestle_platform;
  GRANT EXECUTE ON FUNCTION public.trestle_consume_support_handoff(text, text) TO trestle_app;
  GRANT EXECUTE ON FUNCTION public.trestle_support_view(text, text, text, text) TO trestle_app;
  GRANT EXECUTE ON FUNCTION public.trestle_end_support_view(text) TO trestle_app;
  REVOKE CREATE ON SCHEMA public FROM trestle_platform;
  IF NOT v_superuser THEN EXECUTE format('REVOKE trestle_platform FROM %I', current_user); END IF;
END
$$;
