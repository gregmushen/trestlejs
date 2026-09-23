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
CREATE TABLE "user_regional_preference" (
	"user_id" text PRIMARY KEY NOT NULL,
	"language" text,
	"locale" text,
	"time_zone" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_regional_preference" ADD CONSTRAINT "user_regional_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_regional_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_regional_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_regional_settings_tenant" ON "organization_regional_settings" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
-- Platform operators inspect regional configuration; recovery writes go through the tenant role with an audited reason.
CREATE POLICY "organization_regional_settings_platform" ON "organization_regional_settings" FOR SELECT TO trestle_platform USING (true);
--> statement-breakpoint
ALTER TABLE "user_regional_preference" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_regional_preference" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Preferences belong to an account, not a tenant: the request's user is set per transaction.
CREATE POLICY "user_regional_preference_self" ON "user_regional_preference" TO trestle_app USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
--> statement-breakpoint
CREATE POLICY "user_regional_preference_platform" ON "user_regional_preference" FOR SELECT TO trestle_platform USING (true);
--> statement-breakpoint
REVOKE ALL ON "organization_regional_settings", "user_regional_preference" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "organization_regional_settings" TO trestle_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_regional_preference" TO trestle_app;
--> statement-breakpoint
GRANT SELECT ON "organization_regional_settings", "user_regional_preference" TO trestle_platform;
