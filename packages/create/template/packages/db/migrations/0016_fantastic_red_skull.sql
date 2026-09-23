CREATE TABLE "webhook_secret_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"ciphertext" text,
	"fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"audit_reason" text,
	CONSTRAINT "webhook_secret_version_check" CHECK ("webhook_secret_version"."version" > 0),
	CONSTRAINT "webhook_secret_state_check" CHECK ("webhook_secret_version"."state" IN ('current', 'overlapping', 'revoked')),
	CONSTRAINT "webhook_secret_ciphertext_check" CHECK (("webhook_secret_version"."state" = 'revoked' AND "webhook_secret_version"."ciphertext" IS NULL) OR ("webhook_secret_version"."state" <> 'revoked' AND "webhook_secret_version"."ciphertext" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "webhook_secret_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_secret_endpoint_version_uidx" ON "webhook_secret_version" USING btree ("endpoint_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_secret_current_uidx" ON "webhook_secret_version" USING btree ("endpoint_id") WHERE "webhook_secret_version"."state" = 'current';--> statement-breakpoint
CREATE INDEX "webhook_secret_organization_endpoint_idx" ON "webhook_secret_version" USING btree ("organization_id","endpoint_id");--> statement-breakpoint
ALTER TABLE "webhook_secret_version" ADD CONSTRAINT "webhook_secret_endpoint_tenant_fk" FOREIGN KEY ("endpoint_id","organization_id") REFERENCES "public"."webhook_endpoint"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "webhook_secret_tenant" ON "webhook_secret_version" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("webhook_secret_version"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("webhook_secret_version"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
ALTER TABLE "webhook_secret_version" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "webhook_secret_version" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_secret_version" TO trestle_app;
