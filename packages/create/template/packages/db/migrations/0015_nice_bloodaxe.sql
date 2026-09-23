CREATE TABLE "webhook_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"request_url" text NOT NULL,
	"request_headers" jsonb NOT NULL,
	"request_body" text NOT NULL,
	"simulated_status" integer,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"next_retry_at" timestamp with time zone,
	CONSTRAINT "webhook_attempt_number_check" CHECK ("webhook_attempt"."attempt_number" > 0),
	CONSTRAINT "webhook_attempt_duration_check" CHECK ("webhook_attempt"."duration_ms" >= 0),
	CONSTRAINT "webhook_attempt_outcome_check" CHECK ("webhook_attempt"."outcome" IN ('succeeded', 'retry', 'dead'))
);
--> statement-breakpoint
ALTER TABLE "webhook_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_attempt_delivery_number_uidx" ON "webhook_attempt" USING btree ("delivery_id","attempt_number");--> statement-breakpoint
CREATE INDEX "webhook_attempt_organization_time_idx" ON "webhook_attempt" USING btree ("organization_id","attempted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_delivery_id_organization_uidx" ON "webhook_delivery" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "webhook_attempt" ADD CONSTRAINT "webhook_attempt_delivery_tenant_fk" FOREIGN KEY ("delivery_id","organization_id") REFERENCES "public"."webhook_delivery"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "webhook_attempt_tenant" ON "webhook_attempt" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("webhook_attempt"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("webhook_attempt"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
ALTER TABLE "webhook_attempt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "webhook_attempt" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_attempt" TO trestle_app;
