ALTER TABLE "organization_entitlement_override" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_entitlement_override" ADD COLUMN "removed_by" text;--> statement-breakpoint
ALTER TABLE "organization_entitlement_override" ADD COLUMN "removal_reason" text;--> statement-breakpoint
ALTER TABLE "organization_entitlement_override" ADD CONSTRAINT "organization_entitlement_override_removal_check" CHECK (("removed_at" IS NULL AND "removed_by" IS NULL AND "removal_reason" IS NULL) OR ("removed_at" IS NOT NULL AND "removed_by" IS NOT NULL AND "removal_reason" IS NOT NULL));--> statement-breakpoint
-- Overrides grant commercial authority, so tenant runtimes may read them but never write them.
REVOKE INSERT, UPDATE, DELETE ON "organization_entitlement_override" FROM trestle_app;--> statement-breakpoint
-- The platform admin reads commercial state and authors overrides: insert, or tombstone an active one. It never deletes.
CREATE POLICY "organization_entitlement_override_platform_select" ON "organization_entitlement_override" AS PERMISSIVE FOR SELECT TO trestle_platform USING (true);--> statement-breakpoint
CREATE POLICY "organization_entitlement_override_platform_insert" ON "organization_entitlement_override" AS PERMISSIVE FOR INSERT TO trestle_platform WITH CHECK ("removed_at" IS NULL);--> statement-breakpoint
CREATE POLICY "organization_entitlement_override_platform_remove" ON "organization_entitlement_override" AS PERMISSIVE FOR UPDATE TO trestle_platform USING ("removed_at" IS NULL) WITH CHECK ("removed_at" IS NOT NULL);--> statement-breakpoint
GRANT SELECT, INSERT ON "organization_entitlement_override" TO trestle_platform;--> statement-breakpoint
GRANT UPDATE ("removed_at", "removed_by", "removal_reason") ON "organization_entitlement_override" TO trestle_platform;--> statement-breakpoint
CREATE POLICY "organization_subscription_platform_select" ON "organization_subscription" AS PERMISSIVE FOR SELECT TO trestle_platform USING (true);--> statement-breakpoint
GRANT SELECT ("organization_id", "provider", "plan", "plan_version", "status", "current_period_start", "current_period_end", "cancel_at_period_end", "updated_at") ON "organization_subscription" TO trestle_platform;--> statement-breakpoint
CREATE POLICY "organization_entitlement_platform_select" ON "organization_entitlement" AS PERMISSIVE FOR SELECT TO trestle_platform USING (true);--> statement-breakpoint
GRANT SELECT ON "organization_entitlement" TO trestle_platform;
