CREATE TABLE "api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"service_account_id" text NOT NULL,
	"name" text NOT NULL,
	"environment" text NOT NULL,
	"display_prefix" text NOT NULL,
	"verifier" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_from" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revocation_reason" text,
	CONSTRAINT "api_key_id_check" CHECK ("api_key"."id" ~ '^[A-Za-z0-9]{16}$'),
	CONSTRAINT "api_key_environment_check" CHECK ("api_key"."environment" IN ('local', 'preview', 'staging', 'production')),
	CONSTRAINT "api_key_verifier_check" CHECK ("api_key"."verifier" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "api_key_revocation_check" CHECK (("api_key"."revoked_at" IS NULL AND "api_key"."revoked_by" IS NULL AND "api_key"."revocation_reason" IS NULL) OR ("api_key"."revoked_at" IS NOT NULL AND "api_key"."revoked_by" IS NOT NULL AND "api_key"."revocation_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "api_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "service_account" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"application_roles" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_account_status_check" CHECK ("service_account"."status" IN ('active', 'suspended'))
);
--> statement-breakpoint
ALTER TABLE "service_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- The composite key must exist before the tenant-matching foreign key references it.
CREATE UNIQUE INDEX "service_account_id_organization_uidx" ON "service_account" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_service_account_tenant_fk" FOREIGN KEY ("service_account_id","organization_id") REFERENCES "public"."service_account"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_service_account_idx" ON "api_key" USING btree ("organization_id","service_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_account_name_uidx" ON "service_account" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE POLICY "api_key_tenant" ON "api_key" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("api_key"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("api_key"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "api_key_platform_select" ON "api_key" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
CREATE POLICY "api_key_platform_revoke" ON "api_key" AS PERMISSIVE FOR UPDATE TO "trestle_platform" USING ("api_key"."revoked_at" IS NULL) WITH CHECK ("api_key"."revoked_at" IS NOT NULL);--> statement-breakpoint
CREATE POLICY "service_account_tenant" ON "service_account" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("service_account"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("service_account"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "service_account_platform_select" ON "service_account" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
ALTER TABLE "service_account" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_key" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "service_account", "api_key" FROM PUBLIC;--> statement-breakpoint
-- Tenant runtimes create accounts and keys, but a key's verifier, scopes, and owner are immutable:
-- they may only shorten a key's life or revoke it. Nothing is deleted.
GRANT SELECT, INSERT ON "service_account", "api_key" TO trestle_app;--> statement-breakpoint
GRANT UPDATE ("status", "updated_at") ON "service_account" TO trestle_app;--> statement-breakpoint
GRANT UPDATE ("expires_at", "revoked_at", "revoked_by", "revocation_reason") ON "api_key" TO trestle_app;--> statement-breakpoint
-- The platform admin reads metadata (never verifiers) and may only revoke.
GRANT SELECT ("id", "organization_id", "name", "application_roles", "status", "created_at") ON "service_account" TO trestle_platform;--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "service_account_id", "name", "environment", "display_prefix", "scopes", "expires_at", "created_by", "created_at", "rotated_from", "revoked_at", "revocation_reason") ON "api_key" TO trestle_platform;--> statement-breakpoint
GRANT UPDATE ("revoked_at", "revoked_by", "revocation_reason") ON "api_key" TO trestle_platform;--> statement-breakpoint
-- A request presents only a token, so its key is looked up before any tenant is known.
-- This resolver returns one key by public ID; the caller verifies the token against it.
CREATE OR REPLACE FUNCTION trestle_resolve_api_key(p_public_id text)
RETURNS TABLE (organization_id text, service_account_id text, verifier text, environment text, scopes text[], expires_at timestamp with time zone, revoked_at timestamp with time zone, service_account_status text, application_roles text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT k.organization_id, k.service_account_id, k.verifier, k.environment, k.scopes, k.expires_at, k.revoked_at, s.status, s.application_roles
    FROM public.api_key k
    JOIN public.service_account s ON s.id = k.service_account_id AND s.organization_id = k.organization_id
   WHERE p_public_id ~ '^[A-Za-z0-9]{16}$' AND k.id = p_public_id
   LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION trestle_resolve_api_key(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trestle_resolve_api_key(text) TO trestle_app;--> statement-breakpoint
-- Forced RLS applies to the table owner that runs the resolver, so give the owner a read policy
-- unless it already bypasses RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY "api_key_resolver" ON "api_key" FOR SELECT TO %I USING (true)', current_user);
    EXECUTE format('CREATE POLICY "service_account_resolver" ON "service_account" FOR SELECT TO %I USING (true)', current_user);
  END IF;
END
$$;
