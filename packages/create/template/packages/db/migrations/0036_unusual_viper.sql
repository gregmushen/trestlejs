CREATE TABLE "billing_local_subscription" (
	"provider" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"organization_id" text,
	"provider_customer_id" text,
	"plan" text,
	"status" text NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_local_subscription_pk" PRIMARY KEY("provider","provider_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "billing_provider_event" ADD COLUMN "reconciliation_generation" bigint;--> statement-breakpoint
ALTER TABLE "billing_subscription_reconciliation" ADD COLUMN "reconciled_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_subscription_reconciliation" ADD COLUMN "requested_event_id" text;--> statement-breakpoint
ALTER TABLE "billing_subscription_reconciliation" ADD COLUMN "requested_event_type" text;--> statement-breakpoint
ALTER TABLE "billing_subscription_reconciliation" ADD COLUMN "requested_correlation_id" text;--> statement-breakpoint
ALTER TABLE "billing_subscription_reconciliation" ADD COLUMN "lease_token" text;--> statement-breakpoint
ALTER TABLE "billing_subscription_reconciliation" ADD COLUMN "lease_generation" bigint;--> statement-breakpoint
ALTER TABLE "billing_subscription_reconciliation" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_subscription_reconciliation" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_subscription_reconciliation" ADD COLUMN "last_outcome" text;--> statement-breakpoint
ALTER TABLE "billing_subscription_reconciliation" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX "billing_provider_event_reconciliation_idx" ON "billing_provider_event" USING btree ("provider","provider_subscription_id","reconciliation_generation");--> statement-breakpoint
-- Before this migration the webhook reconciled inline, so existing cursors are not due.
-- A receipt that failed then is redelivered by Stripe and requests a new generation.
UPDATE "billing_subscription_reconciliation" SET "reconciled_generation" = "generation";--> statement-breakpoint
REVOKE ALL ON "billing_local_subscription" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "billing_local_subscription" TO trestle_app;
