CREATE TABLE "webhook_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"message_id" text NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"terminal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "webhook_delivery" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_message" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source_event_id" uuid NOT NULL,
	"public_event_type" text NOT NULL,
	"public_version" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"envelope" jsonb,
	"payload_size" integer NOT NULL,
	"retention_class" text NOT NULL,
	"entitlement_decision" text NOT NULL,
	"status" text NOT NULL,
	"correlation_id" text NOT NULL,
	"causation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_deleted_at" timestamp with time zone,
	CONSTRAINT "webhook_message_version_check" CHECK ("webhook_message"."public_version" > 0),
	CONSTRAINT "webhook_message_retention_check" CHECK ("webhook_message"."retention_class" IN ('standard', 'short')),
	CONSTRAINT "webhook_message_entitlement_check" CHECK ("webhook_message"."entitlement_decision" IN ('not_required', 'allowed', 'denied')),
	CONSTRAINT "webhook_message_status_check" CHECK ("webhook_message"."status" IN ('ready', 'suppressed'))
);
--> statement-breakpoint
ALTER TABLE "webhook_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_delivery_message_endpoint_uidx" ON "webhook_delivery" USING btree ("message_id","endpoint_id");--> statement-breakpoint
CREATE INDEX "webhook_delivery_organization_state_idx" ON "webhook_delivery" USING btree ("organization_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_message_id_organization_uidx" ON "webhook_message" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_message_tenant_fk" FOREIGN KEY ("message_id","organization_id") REFERENCES "public"."webhook_message"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpoint_tenant_fk" FOREIGN KEY ("endpoint_id","organization_id") REFERENCES "public"."webhook_endpoint"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_message_source_projection_uidx" ON "webhook_message" USING btree ("organization_id","source_event_id","public_event_type","public_version");--> statement-breakpoint
CREATE INDEX "webhook_message_organization_created_idx" ON "webhook_message" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE POLICY "webhook_delivery_tenant" ON "webhook_delivery" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("webhook_delivery"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("webhook_delivery"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "webhook_message_tenant" ON "webhook_message" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("webhook_message"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("webhook_message"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
ALTER TABLE "webhook_message" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_delivery" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "webhook_message" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON "webhook_delivery" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_message" TO trestle_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_delivery" TO trestle_app;
