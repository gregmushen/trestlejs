ALTER TABLE "webhook_delivery" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD COLUMN "leased_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "webhook_delivery_lease_recovery_idx" ON "webhook_delivery" USING btree ("state","leased_until");--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_state_check" CHECK ("webhook_delivery"."state" IN ('pending', 'leased', 'retry', 'succeeded', 'dead'));--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_lease_pair_check" CHECK (("webhook_delivery"."state" = 'leased' AND "webhook_delivery"."lease_token" IS NOT NULL AND "webhook_delivery"."leased_until" IS NOT NULL) OR ("webhook_delivery"."state" <> 'leased' AND "webhook_delivery"."lease_token" IS NULL AND "webhook_delivery"."leased_until" IS NULL));
