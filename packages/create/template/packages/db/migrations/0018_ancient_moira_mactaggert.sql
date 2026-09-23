ALTER TABLE "webhook_attempt" DROP CONSTRAINT "webhook_attempt_outcome_check";--> statement-breakpoint
ALTER TABLE "webhook_delivery" DROP CONSTRAINT "webhook_delivery_state_check";--> statement-breakpoint
ALTER TABLE "webhook_attempt" ALTER COLUMN "request_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_attempt" ALTER COLUMN "request_body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_attempt" ADD COLUMN "response_status" integer;--> statement-breakpoint
ALTER TABLE "webhook_attempt" ADD COLUMN "result_category" text;--> statement-breakpoint
ALTER TABLE "webhook_attempt" ADD CONSTRAINT "webhook_attempt_response_status_check" CHECK ("webhook_attempt"."response_status" IS NULL OR "webhook_attempt"."response_status" BETWEEN 100 AND 599);--> statement-breakpoint
ALTER TABLE "webhook_attempt" ADD CONSTRAINT "webhook_attempt_result_category_check" CHECK ("webhook_attempt"."result_category" IS NULL OR "webhook_attempt"."result_category" IN ('http', 'timeout', 'network', 'tls', 'blocked_address'));--> statement-breakpoint
ALTER TABLE "webhook_attempt" ADD CONSTRAINT "webhook_attempt_outcome_check" CHECK ("webhook_attempt"."outcome" IN ('succeeded', 'retry', 'dead', 'exhausted'));--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_state_check" CHECK ("webhook_delivery"."state" IN ('pending', 'leased', 'retry', 'succeeded', 'dead', 'exhausted'));
