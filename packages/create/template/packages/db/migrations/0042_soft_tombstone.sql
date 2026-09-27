CREATE TABLE "email_suppression" (
	"organization_id" text NOT NULL,
	"address" text NOT NULL,
	"reason" text NOT NULL,
	"source_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_suppression_reason_check" CHECK ("email_suppression"."reason" IN ('unsubscribed', 'bounced', 'complained')),
	CONSTRAINT "email_suppression_address_check" CHECK ("email_suppression"."address" = lower("email_suppression"."address"))
);
--> statement-breakpoint
ALTER TABLE "email_suppression" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_delivery_event" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "email_delivery_event" ADD COLUMN "bounce_type" text;--> statement-breakpoint
ALTER TABLE "email_delivery_event" ADD COLUMN "bounce_sub_type" text;--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppression_organization_address_uidx" ON "email_suppression" USING btree ("organization_id","address");--> statement-breakpoint
CREATE INDEX "email_delivery_event_received_idx" ON "email_delivery_event" USING btree ("received_at");--> statement-breakpoint
CREATE POLICY "email_suppression_tenant" ON "email_suppression" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("email_suppression"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("email_suppression"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "email_suppression_platform_select" ON "email_suppression" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
CREATE POLICY "email_suppression_platform_delete" ON "email_suppression" AS PERMISSIVE FOR DELETE TO "trestle_platform" USING (true);--> statement-breakpoint
ALTER TABLE "email_suppression" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Verified Resend webhooks record hard bounces and complaints in the tenant's transaction;
-- the application records unsubscribes.
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_suppression" TO trestle_app;--> statement-breakpoint
-- Platform operators read suppressions and remove one with a reason (audited in the same
-- transaction); they never add one, so the platform role has no INSERT or UPDATE.
GRANT SELECT, DELETE ON "email_suppression" TO trestle_platform;--> statement-breakpoint
-- The deliverability view reads the tenant binding and bounce classification; never a recipient.
GRANT SELECT ("organization_id", "bounce_type", "bounce_sub_type") ON "email_delivery_event" TO trestle_platform;