DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trestle_platform') THEN
    CREATE ROLE trestle_platform NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO trestle_platform;
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"service_account_id" text NOT NULL,
	"environment" text NOT NULL,
	"display_prefix" text NOT NULL,
	"verifier" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"scope_profile_id" text,
	"expires_at" timestamp with time zone,
	"allowed_cidrs" text[],
	"rate_limit_per_minute" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"rotated_from" text,
	"rotated_to" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revocation_reason" text
);
--> statement-breakpoint
CREATE TABLE "api_key_usage" (
	"organization_id" text NOT NULL,
	"api_key_id" text NOT NULL,
	"day" date NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"denied" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_key_usage_api_key_id_day_pk" PRIMARY KEY("api_key_id","day")
);
--> statement-breakpoint
CREATE TABLE "application_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_role_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revocation_reason" text
);
--> statement-breakpoint
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
CREATE TABLE "platform_tenant_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"reason" text NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"exited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scope_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_account" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"application_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspended_by" text,
	"suspension_reason" text
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"organization_id" text,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"environment" text NOT NULL,
	"correlation_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_version" (
	"plan" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"entitlements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activated_at" timestamp with time zone,
	"grandfathered_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_version_plan_version_pk" PRIMARY KEY("plan","version")
);
--> statement-breakpoint
CREATE TABLE "provider_reconciliation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"outcome" text NOT NULL,
	"differences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repaired" boolean DEFAULT false NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_change" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"to_plan_version" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"author" text NOT NULL,
	"applied_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_override" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"code" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"author" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	"removal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_aggregate" (
	"organization_id" text NOT NULL,
	"feature_code" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"quantity" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_aggregate_organization_id_feature_code_period_start_pk" PRIMARY KEY("organization_id","feature_code","period_start")
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "suspension_reason" text;--> statement-breakpoint
ALTER TABLE "organization_entitlement" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_entitlement" ADD COLUMN "values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_entitlement" ADD COLUMN "source" text DEFAULT 'plan' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_entitlement" ADD COLUMN "inherited_from" text;--> statement-breakpoint
ALTER TABLE "organization_entitlement" ADD COLUMN "override_id" text;--> statement-breakpoint
ALTER TABLE "organization_entitlement" ADD COLUMN "effective_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_entitlement" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_subscription" ALTER COLUMN "plan_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "organization_subscription" ALTER COLUMN "plan_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_subscription" ALTER COLUMN "plan_version" SET DATA TYPE text USING "plan" || '@' || "plan_version"::text;--> statement-breakpoint
ALTER TABLE "organization_subscription" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_service_account_id_service_account_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_organization_idx" ON "api_key" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "api_key_service_account_idx" ON "api_key" USING btree ("service_account_id");--> statement-breakpoint
CREATE INDEX "api_key_usage_organization_idx" ON "api_key_usage" USING btree ("organization_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "application_role_organization_key_uidx" ON "application_role" USING btree ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "application_role_assignment_active_uidx" ON "application_role_assignment" USING btree ("organization_id","user_id","role",coalesce("resource_type", ''),coalesce("resource_id", '')) WHERE "application_role_assignment"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "application_role_assignment_user_idx" ON "application_role_assignment" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_role_assignment_active_uidx" ON "platform_role_assignment" USING btree ("user_id","role") WHERE "platform_role_assignment"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "platform_role_assignment_user_idx" ON "platform_role_assignment" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "platform_tenant_context_operator_idx" ON "platform_tenant_context" USING btree ("operator_id","entered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scope_profile_organization_name_uidx" ON "scope_profile" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "service_account_organization_idx" ON "service_account" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "audit_event_organization_idx" ON "audit_event" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_event_name_idx" ON "audit_event" USING btree ("name","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_event_actor_idx" ON "audit_event" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "provider_reconciliation_organization_idx" ON "provider_reconciliation" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "subscription_change_organization_idx" ON "subscription_change" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "subscription_override_organization_idx" ON "subscription_override" USING btree ("organization_id");
--> statement-breakpoint
ALTER TABLE "application_role" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "application_role" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "application_role_tenant" ON "application_role" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "application_role_platform" ON "application_role" TO trestle_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "application_role_assignment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "application_role_assignment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "application_role_assignment_tenant" ON "application_role_assignment" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "application_role_assignment_platform" ON "application_role_assignment" FOR SELECT TO trestle_platform USING (true);
--> statement-breakpoint
ALTER TABLE "service_account" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "service_account" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_account_tenant" ON "service_account" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "service_account_platform" ON "service_account" TO trestle_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "api_key" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "api_key" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "api_key_tenant" ON "api_key" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "api_key_platform" ON "api_key" TO trestle_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "scope_profile" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "scope_profile" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "scope_profile_tenant" ON "scope_profile" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "scope_profile_platform" ON "scope_profile" TO trestle_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "api_key_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "api_key_usage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "api_key_usage_tenant" ON "api_key_usage" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "api_key_usage_platform" ON "api_key_usage" TO trestle_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "subscription_override" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription_override" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "subscription_override_tenant" ON "subscription_override" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "subscription_override_platform" ON "subscription_override" TO trestle_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "subscription_change" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription_change" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "subscription_change_tenant" ON "subscription_change" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "subscription_change_platform" ON "subscription_change" TO trestle_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "usage_aggregate" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "usage_aggregate" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "usage_aggregate_tenant" ON "usage_aggregate" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "usage_aggregate_platform" ON "usage_aggregate" TO trestle_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_event_tenant_select" ON "audit_event" FOR SELECT TO trestle_app USING (organization_id IS NOT NULL AND organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "audit_event_tenant_insert" ON "audit_event" FOR INSERT TO trestle_app WITH CHECK (organization_id IS NOT NULL AND organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "audit_event_platform_select" ON "audit_event" FOR SELECT TO trestle_platform USING (true);
--> statement-breakpoint
CREATE POLICY "audit_event_platform_insert" ON "audit_event" FOR INSERT TO trestle_platform WITH CHECK (true);
--> statement-breakpoint
REVOKE ALL ON "application_role", "application_role_assignment", "service_account", "api_key", "scope_profile", "api_key_usage", "subscription_override", "subscription_change", "usage_aggregate", "audit_event", "plan_version", "platform_role_assignment", "platform_tenant_context", "provider_reconciliation" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "application_role", "scope_profile" TO trestle_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "application_role_assignment" TO trestle_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "service_account", "api_key_usage", "usage_aggregate" TO trestle_app;
--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "service_account_id", "environment", "display_prefix", "scopes", "scope_profile_id", "expires_at", "allowed_cidrs", "rate_limit_per_minute", "created_by", "created_at", "last_used_at", "rotated_from", "rotated_to", "revoked_at", "revoked_by", "revocation_reason") ON "api_key" TO trestle_app;
--> statement-breakpoint
GRANT INSERT ON "api_key" TO trestle_app;
--> statement-breakpoint
GRANT UPDATE ("expires_at", "last_used_at", "rotated_to", "revoked_at", "revoked_by", "revocation_reason") ON "api_key" TO trestle_app;
--> statement-breakpoint
GRANT SELECT ON "subscription_override", "subscription_change", "plan_version" TO trestle_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_event" TO trestle_app;
--> statement-breakpoint
GRANT SELECT ON "application_role", "scope_profile", "application_role_assignment" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "service_account" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "service_account_id", "environment", "display_prefix", "scopes", "scope_profile_id", "expires_at", "allowed_cidrs", "rate_limit_per_minute", "created_by", "created_at", "last_used_at", "rotated_from", "rotated_to", "revoked_at", "revoked_by", "revocation_reason") ON "api_key" TO trestle_platform;
--> statement-breakpoint
GRANT UPDATE ("revoked_at", "revoked_by", "revocation_reason") ON "api_key" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT ON "api_key_usage", "usage_aggregate" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "subscription_override", "subscription_change", "plan_version", "platform_role_assignment", "platform_tenant_context" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_event", "provider_reconciliation" TO trestle_platform;
--> statement-breakpoint
CREATE POLICY "tenant_record_platform" ON "tenant_record" FOR SELECT TO trestle_platform USING (true);
--> statement-breakpoint
CREATE POLICY "artifact_metadata_platform" ON "artifact_metadata" FOR SELECT TO trestle_platform USING (true);
--> statement-breakpoint
CREATE POLICY "organization_subscription_platform" ON "organization_subscription" TO trestle_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "organization_entitlement_platform" ON "organization_entitlement" TO trestle_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT ON "tenant_record", "artifact_metadata", "email_delivery_event", "billing_provider_event" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "organization_subscription" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_entitlement" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "outbox_message" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT ON "user", "member", "organization", "invitation" TO trestle_platform;
--> statement-breakpoint
GRANT UPDATE ("suspended_at", "suspension_reason") ON "user" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT ("id", "user_id", "expires_at", "created_at", "updated_at", "ip_address", "user_agent", "active_organization_id"), DELETE ON "session" TO trestle_platform;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations') THEN
    GRANT USAGE ON SCHEMA drizzle TO trestle_platform;
    GRANT SELECT ON drizzle.__drizzle_migrations TO trestle_platform;
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trestle_resolve_api_key(p_public_id text)
RETURNS TABLE (organization_id text, service_account_id text, verifier text, environment text, scopes text[], expires_at timestamp with time zone, revoked_at timestamp with time zone, allowed_cidrs text[], service_account_status text, service_account_roles text[], rate_limit_per_minute integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT k.organization_id, k.service_account_id, k.verifier, k.environment, k.scopes, k.expires_at, k.revoked_at, k.allowed_cidrs, s.status, s.application_roles, k.rate_limit_per_minute
    FROM public.api_key k
    JOIN public.service_account s ON s.id = k.service_account_id AND s.organization_id = k.organization_id
   WHERE p_public_id ~ '^[A-Za-z0-9]{16}$' AND k.id = p_public_id
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION trestle_resolve_api_key(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trestle_resolve_api_key(text) TO trestle_app;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY "api_key_resolver" ON "api_key" FOR SELECT TO %I USING (true)', current_user);
    EXECUTE format('CREATE POLICY "service_account_resolver" ON "service_account" FOR SELECT TO %I USING (true)', current_user);
  END IF;
END
$$;
--> statement-breakpoint
INSERT INTO "plan_version" ("plan", "version", "name", "state", "entitlements", "activated_at", "created_by") VALUES
  ('starter', 1, 'Starter', 'active', '{"workspace.single": {}, "article.basic": {}, "team.members": {"maximum": 3}}'::jsonb, '2026-01-01T00:00:00Z', 'system:migration'),
  ('pro', 1, 'Pro', 'active', '{"workspace.single": {}, "article.basic": {}, "team.members": {"maximum": 25}, "workflows.advanced": {}, "api.access": {"maxKeys": 5}, "api.requests": {"included": 100000, "limit": 250000, "enforcement": "hard", "overage": "block"}}'::jsonb, '2026-01-01T00:00:00Z', 'system:migration'),
  ('business', 1, 'Business', 'active', '{"workspace.single": {}, "article.basic": {}, "team.members": {"maximum": null}, "workflows.advanced": {}, "roles.custom": {}, "api.access": {"maxKeys": 50}, "api.requests": {"included": 1000000, "limit": null, "enforcement": "soft", "overage": "bill"}, "support.priority": {"responseTime": "PT4H"}}'::jsonb, '2026-01-01T00:00:00Z', 'system:migration')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "organization_subscription" SET "plan_version" = "plan" || '@1' WHERE "plan_version" IS NULL;
