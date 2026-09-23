-- The platform admin's database role: NOLOGIN, no RLS bypass, never granted to a tenant runtime.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trestle_platform') THEN
    CREATE ROLE trestle_platform NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint
CREATE TABLE "platform_role_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by" text NOT NULL,
	"reason" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revocation_reason" text
);
--> statement-breakpoint
ALTER TABLE "platform_role_assignment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_role_assignment" ADD CONSTRAINT "platform_role_assignment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_role_assignment_active_uidx" ON "platform_role_assignment" USING btree ("user_id","role") WHERE "platform_role_assignment"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "platform_role_assignment_user_idx" ON "platform_role_assignment" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "audit_event_platform_select" ON "audit_event" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
CREATE POLICY "audit_event_platform_insert" ON "audit_event" AS PERMISSIVE FOR INSERT TO "trestle_platform" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "platform_role_assignment_platform" ON "platform_role_assignment" AS PERMISSIVE FOR ALL TO "trestle_platform" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "platform_role_assignment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Tenant runtimes have no access to platform-role assignments.
REVOKE ALL ON "platform_role_assignment" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "platform_role_assignment" TO trestle_platform;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO trestle_platform;--> statement-breakpoint
-- Platform audit: read all history and append platform records; never update or delete.
GRANT SELECT, INSERT ON "audit_event" TO trestle_platform;--> statement-breakpoint
-- Sanitized directory reads for the admin. No credentials, sessions, tokens, or tenant data tables.
GRANT SELECT ON "organization", "member" TO trestle_platform;--> statement-breakpoint
GRANT SELECT ("id", "name", "email", "email_verified", "created_at") ON "user" TO trestle_platform;
