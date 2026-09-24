CREATE TABLE "billing_subscription_reconciliation" (
	"provider" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscription_reconciliation_pk" PRIMARY KEY("provider","provider_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "billing_provider_event" ADD COLUMN "provider_subscription_id" text;
--> statement-breakpoint
REVOKE ALL ON "billing_subscription_reconciliation" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "billing_subscription_reconciliation" TO trestle_app;
