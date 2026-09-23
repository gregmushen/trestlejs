CREATE TABLE "organization_regional_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"language" text,
	"locale" text,
	"time_zone" text,
	"currency" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_regional_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organization_regional_settings_tenant" ON "organization_regional_settings" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("organization_regional_settings"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("organization_regional_settings"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "organization_regional_settings_platform_select" ON "organization_regional_settings" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
ALTER TABLE "organization_regional_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "organization_regional_settings" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "organization_regional_settings" TO trestle_app;--> statement-breakpoint
-- Support sessions show an organization's regional defaults; the platform never changes them.
GRANT SELECT ON "organization_regional_settings" TO trestle_platform;
