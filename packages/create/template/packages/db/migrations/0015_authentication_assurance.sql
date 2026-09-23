CREATE TABLE "authentication_assurance" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"level" text NOT NULL,
	"method" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL
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
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authentication_assurance_user_idx" ON "authentication_assurance" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_user_id_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credential_id_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "two_factor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "two_factor_user_id_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
REVOKE ALL ON "authentication_assurance", "passkey", "two_factor" FROM PUBLIC;
--> statement-breakpoint
-- Operators see how a session was authenticated and which factors a user has,
-- never TOTP secrets, backup codes, or WebAuthn public keys and credential IDs.
GRANT SELECT ON "authentication_assurance" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT ("id", "name", "user_id", "device_type", "backed_up", "created_at") ON "passkey" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT ("id", "user_id", "verified") ON "two_factor" TO trestle_platform;
--> statement-breakpoint
-- Account-security events (factor enrolled or removed) are user-scoped, not
-- tenant-scoped; this narrow function records them in the platform audit trail.
CREATE OR REPLACE FUNCTION trestle_record_security_event(p_name text, p_user_id text, p_summary text, p_correlation_id text, p_environment text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.audit_event (name, schema_version, actor_type, actor_id, organization_id, target_type, target_id, summary, outcome, environment, correlation_id)
  SELECT p_name, 1, 'user', p_user_id, NULL, 'user', p_user_id, p_summary::jsonb, 'succeeded', p_environment, p_correlation_id
   WHERE p_name ~ '^security\.[a-z_]+\.[a-z_]+$'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION trestle_record_security_event(text, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trestle_record_security_event(text, text, text, text, text) TO trestle_app;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY "audit_event_security_owner" ON "audit_event" FOR INSERT TO %I WITH CHECK (organization_id IS NULL AND name LIKE %L)', current_user, 'security.%');
  END IF;
END
$$;
