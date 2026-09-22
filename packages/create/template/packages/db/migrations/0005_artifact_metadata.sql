CREATE TABLE "artifact_metadata" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "artifact_metadata_organization_idx" ON "artifact_metadata" USING btree ("organization_id");
--> statement-breakpoint
ALTER TABLE "artifact_metadata" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "artifact_metadata" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "artifact_metadata_tenant" ON "artifact_metadata" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
REVOKE ALL ON "artifact_metadata" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "artifact_metadata" TO trestle_app;
