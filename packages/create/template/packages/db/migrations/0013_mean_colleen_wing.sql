CREATE TABLE "webhook_endpoint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"environment" text NOT NULL,
	"name" text NOT NULL,
	"destination_url" text NOT NULL,
	"state" text DEFAULT 'disabled' NOT NULL,
	"health" text DEFAULT 'unknown' NOT NULL,
	"provider" text NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "webhook_endpoint_state_check" CHECK ("webhook_endpoint"."state" IN ('disabled', 'active', 'paused')),
	CONSTRAINT "webhook_endpoint_health_check" CHECK ("webhook_endpoint"."health" IN ('unknown', 'healthy', 'degraded', 'failed')),
	CONSTRAINT "webhook_endpoint_provider_check" CHECK ("webhook_endpoint"."provider" IN ('local', 'native', 'svix'))
);
--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_subscription" (
	"organization_id" text NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"public_event_type" text NOT NULL,
	"public_version" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_subscription_pk" PRIMARY KEY("endpoint_id","public_event_type","public_version"),
	CONSTRAINT "webhook_subscription_version_check" CHECK ("webhook_subscription"."public_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "webhook_subscription" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoint_id_organization_uidx" ON "webhook_endpoint" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "webhook_subscription" ADD CONSTRAINT "webhook_subscription_endpoint_tenant_fk" FOREIGN KEY ("endpoint_id","organization_id") REFERENCES "public"."webhook_endpoint"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_endpoint_organization_idx" ON "webhook_endpoint" USING btree ("organization_id","environment");--> statement-breakpoint
CREATE INDEX "webhook_subscription_organization_event_idx" ON "webhook_subscription" USING btree ("organization_id","public_event_type","public_version");--> statement-breakpoint
CREATE POLICY "webhook_endpoint_tenant" ON "webhook_endpoint" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("webhook_endpoint"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("webhook_endpoint"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "webhook_subscription_tenant" ON "webhook_subscription" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("webhook_subscription"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("webhook_subscription"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
ALTER TABLE "webhook_endpoint" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_subscription" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "webhook_endpoint" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON "webhook_subscription" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_endpoint" TO trestle_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_subscription" TO trestle_app;
