CREATE POLICY "artifact_metadata_platform_select" ON "artifact_metadata" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
CREATE POLICY "webhook_delivery_platform_select" ON "webhook_delivery" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
CREATE POLICY "webhook_delivery_platform_replay" ON "webhook_delivery" AS PERMISSIVE FOR UPDATE TO "trestle_platform" USING ("webhook_delivery"."state" IN ('dead', 'exhausted')) WITH CHECK ("webhook_delivery"."state" = 'retry');--> statement-breakpoint
CREATE POLICY "webhook_message_platform_select" ON "webhook_message" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
CREATE POLICY "webhook_endpoint_platform_select" ON "webhook_endpoint" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
CREATE POLICY "webhook_endpoint_platform_disable" ON "webhook_endpoint" AS PERMISSIVE FOR UPDATE TO "trestle_platform" USING (true) WITH CHECK ("webhook_endpoint"."state" = 'disabled');--> statement-breakpoint
-- Platform operations reads are metadata-only: no event payloads, webhook envelopes or
-- destinations, lease tokens, or artifact storage keys.
GRANT SELECT ("id", "event_name", "schema_version", "occurred_at", "resource_type", "organization_id", "correlation_id", "status", "attempts", "available_at", "last_error", "created_at", "processed_at") ON "outbox_message" TO trestle_platform;--> statement-breakpoint
-- Redrive: a dead outbox event returns to pending (outbox_message has no RLS; the admin constrains the transition).
GRANT UPDATE ("status", "available_at", "leased_until", "last_error") ON "outbox_message" TO trestle_platform;--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "environment", "name", "state", "health", "provider", "created_at", "updated_at", "deleted_at") ON "webhook_endpoint" TO trestle_platform;--> statement-breakpoint
GRANT UPDATE ("state", "updated_at", "updated_by") ON "webhook_endpoint" TO trestle_platform;--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "message_id", "endpoint_id", "state", "next_attempt_at", "attempt_count", "terminal_reason", "created_at", "completed_at") ON "webhook_delivery" TO trestle_platform;--> statement-breakpoint
GRANT UPDATE ("state", "next_attempt_at", "terminal_reason", "completed_at") ON "webhook_delivery" TO trestle_platform;--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "public_event_type", "public_version", "status", "correlation_id", "created_at", "payload_deleted_at") ON "webhook_message" TO trestle_platform;--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "content_type", "size", "created_at", "deleted_at", "upload_state") ON "artifact_metadata" TO trestle_platform;
