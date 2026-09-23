ALTER TABLE "artifact_metadata" DROP CONSTRAINT "artifact_metadata_upload_state_check";--> statement-breakpoint
ALTER TABLE "artifact_metadata" ADD CONSTRAINT "artifact_metadata_upload_state_check" CHECK ("artifact_metadata"."upload_state" IN ('pending', 'ready', 'cleaning', 'deleted'));
