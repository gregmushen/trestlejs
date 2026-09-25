CREATE TABLE "authentication_assurance" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"level" text NOT NULL,
	"method" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	CONSTRAINT "authentication_assurance_level_check" CHECK ("authentication_assurance"."level" IN ('password', 'mfa', 'phishing_resistant')),
	CONSTRAINT "authentication_assurance_method_check" CHECK ("authentication_assurance"."method" IN ('password', 'totp', 'otp', 'backup_code', 'passkey', 'sso'))
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "authentication_assurance" ADD CONSTRAINT "authentication_assurance_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authentication_assurance_user_idx" ON "authentication_assurance" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_user_id_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credential_id_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "two_factor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "two_factor_user_id_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint

-- Account-security events: organization-less, actor and target are the same user, fixed outcome.
-- The runtime login may name any user: it already writes user and session rows, so this grants it nothing new.
-- Executable only by the runtime login (granted in configureRuntimeRole); never by trestle_app.
-- plpgsql (not sql) so invalid input raises instead of silently inserting nothing.
CREATE FUNCTION trestle_record_security_event(p_name text, p_user_id text, p_correlation_id text, p_environment text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_name IS NULL OR length(p_name) > 120 OR p_name !~ '^security\.[a-z_]+\.[a-z_]+$' THEN
    RAISE EXCEPTION 'Invalid security event name: %', p_name USING ERRCODE = '22023';
  END IF;
  IF nullif(p_user_id, '') IS NULL THEN
    RAISE EXCEPTION 'Invalid security event user id' USING ERRCODE = '22023';
  END IF;
  IF nullif(p_correlation_id, '') IS NULL THEN
    RAISE EXCEPTION 'Invalid security event correlation id' USING ERRCODE = '22023';
  END IF;
  IF nullif(p_environment, '') IS NULL THEN
    RAISE EXCEPTION 'Invalid security event environment' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.audit_event (name, schema_version, actor_type, actor_id, organization_id, target_type, target_id, summary, outcome, environment, correlation_id)
  VALUES (p_name, '1', 'user', p_user_id, NULL, 'user', p_user_id, '{}'::jsonb, 'succeeded', p_environment, p_correlation_id);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION trestle_record_security_event(text, text, text, text) FROM PUBLIC;--> statement-breakpoint
-- audit_event forces RLS; the function owner needs an insert policy unless it bypasses RLS.
-- Migration 0028 already granted the owner an unrestricted "audit_event_replay_owner" INSERT
-- policy, so this policy only matters if that one is ever dropped.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY "audit_event_security_owner" ON "audit_event" FOR INSERT TO %I WITH CHECK (organization_id IS NULL AND name LIKE %L)', current_user, 'security.%');
  END IF;
END
$$;
