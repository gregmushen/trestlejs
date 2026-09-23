ALTER TABLE "artifact_metadata" ADD COLUMN "upload_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
UPDATE "artifact_metadata" SET "upload_state" = CASE WHEN "deleted_at" IS NULL THEN 'ready' ELSE 'deleted' END;--> statement-breakpoint
CREATE INDEX "artifact_metadata_upload_state_idx" ON "artifact_metadata" USING btree ("upload_state","created_at");--> statement-breakpoint
ALTER TABLE "artifact_metadata" ADD CONSTRAINT "artifact_metadata_upload_state_check" CHECK ("artifact_metadata"."upload_state" IN ('pending', 'ready', 'deleted'));
