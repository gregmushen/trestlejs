CREATE TABLE "access_permission" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"plane" text NOT NULL,
	"principals" text[] DEFAULT '{user}'::text[] NOT NULL,
	"entitlement" text,
	"state" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deprecated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "access_role" (
	"plane" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"based_on" text,
	"archived_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_role_plane_key_pk" PRIMARY KEY("plane","key")
);
--> statement-breakpoint
CREATE TABLE "billing_provider_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"plan" text NOT NULL,
	"plan_version" integer,
	"offer" text,
	"external_id" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verification" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"plan_version" text NOT NULL,
	"offer" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"provider_item_id" text,
	"provider_price_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_stream" (
	"type" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" text
);
--> statement-breakpoint
CREATE TABLE "notification_stream_version" (
	"type" text NOT NULL,
	"version" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	CONSTRAINT "notification_stream_version_type_version_pk" PRIMARY KEY("type","version")
);
--> statement-breakpoint
CREATE TABLE "auth_policy_version" (
	"version" integer PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"policy" jsonb NOT NULL,
	"based_on" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" text,
	"activated_at" timestamp with time zone,
	"reason" text
);
--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "replaced_by" text;--> statement-breakpoint
ALTER TABLE "service_account" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_account" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "service_account" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "stream_version" integer;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD COLUMN "timeout_ms" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
ALTER TABLE "notification_stream_version" ADD CONSTRAINT "notification_stream_version_type_notification_stream_type_fk" FOREIGN KEY ("type") REFERENCES "public"."notification_stream"("type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_provider_mapping_target_uidx" ON "billing_provider_mapping" USING btree ("environment","provider","kind","plan",coalesce("plan_version", 0),coalesce("offer", ''));--> statement-breakpoint
CREATE UNIQUE INDEX "billing_provider_mapping_external_uidx" ON "billing_provider_mapping" USING btree ("environment","provider","kind","external_id");--> statement-breakpoint
CREATE INDEX "subscription_line_organization_idx" ON "subscription_line" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_stream_active_uidx" ON "notification_stream_version" USING btree ("type") WHERE "notification_stream_version"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "notification_stream_draft_uidx" ON "notification_stream_version" USING btree ("type") WHERE "notification_stream_version"."state" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "auth_policy_version_active_uidx" ON "auth_policy_version" USING btree ("state") WHERE "auth_policy_version"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "auth_policy_version_draft_uidx" ON "auth_policy_version" USING btree ("state") WHERE "auth_policy_version"."state" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_idempotency_uidx" ON "api_key" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
-- Existing duplicate names within an organization keep working under a disambiguated name.
UPDATE "service_account" s SET "name" = s."name" || ' (' || s."id" || ')'
 WHERE EXISTS (SELECT 1 FROM "service_account" o WHERE o."organization_id" = s."organization_id" AND lower(o."name") = lower(s."name") AND o."id" < s."id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_account_active_name_uidx" ON "service_account" USING btree ("organization_id",lower("name")) WHERE "service_account"."deleted_at" is null;--> statement-breakpoint
-- Global catalogs: readable by the application runtime, written only by the platform role.
REVOKE ALL ON "access_permission", "access_role", "notification_stream", "notification_stream_version", "billing_provider_mapping", "auth_policy_version" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON "access_permission", "access_role", "notification_stream", "notification_stream_version", "billing_provider_mapping", "auth_policy_version" TO trestle_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "access_permission", "access_role", "notification_stream", "notification_stream_version", "billing_provider_mapping", "auth_policy_version" TO trestle_platform;
--> statement-breakpoint
-- Subscription lines are tenant data.
ALTER TABLE "subscription_line" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription_line" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "subscription_line_tenant" ON "subscription_line" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "subscription_line_platform" ON "subscription_line" TO trestle_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE ALL ON "subscription_line" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "subscription_line" TO trestle_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "subscription_line" TO trestle_platform;
--> statement-breakpoint
-- New safe metadata is visible to operators; verifiers, idempotency keys, and signing secrets stay hidden.
GRANT SELECT ("name", "replaced_by") ON "api_key" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT ("description", "timeout_ms", "deleted_at", "deleted_by", "deletion_reason") ON "webhook_endpoint" TO trestle_platform;
--> statement-breakpoint
-- Workers never deliver to a deleted endpoint, even for deliveries queued before deletion.
CREATE OR REPLACE FUNCTION trestle_due_webhook_deliveries(p_limit integer)
RETURNS TABLE (id text, organization_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT d.id, d.organization_id FROM public.webhook_delivery d
    JOIN public.webhook_endpoint e ON e.id = d.endpoint_id AND e.state = 'active' AND e.deleted_at IS NULL
   WHERE d.status = 'pending' AND d.next_attempt_at <= now()
   ORDER BY d.next_attempt_at LIMIT least(greatest(p_limit, 1), 100)
$$;
--> statement-breakpoint
-- A deleted service account authenticates nothing, even through a key that escaped revocation.
CREATE OR REPLACE FUNCTION trestle_resolve_api_key(p_public_id text)
RETURNS TABLE (organization_id text, service_account_id text, verifier text, environment text, scopes text[], expires_at timestamp with time zone, revoked_at timestamp with time zone, allowed_cidrs text[], service_account_status text, service_account_roles text[], rate_limit_per_minute integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT k.organization_id, k.service_account_id, k.verifier, k.environment, k.scopes, k.expires_at, k.revoked_at, k.allowed_cidrs,
         CASE WHEN s.deleted_at IS NOT NULL THEN 'deleted' ELSE s.status END, s.application_roles, k.rate_limit_per_minute
    FROM public.api_key k
    JOIN public.service_account s ON s.id = k.service_account_id AND s.organization_id = k.organization_id
   WHERE p_public_id ~ '^[A-Za-z0-9]{16}$' AND k.id = p_public_id
   LIMIT 1
$$;
--> statement-breakpoint
-- The tenant runtime reads the new key metadata and records replacements; verifiers stay unreadable.
GRANT SELECT ("name", "idempotency_key", "replaced_by") ON "api_key" TO trestle_app;
--> statement-breakpoint
GRANT UPDATE ("replaced_by") ON "api_key" TO trestle_app;
