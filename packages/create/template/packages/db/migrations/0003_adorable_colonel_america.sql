CREATE TABLE "billing_provider_event" (
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	CONSTRAINT "billing_provider_event_provider_provider_event_id_pk" PRIMARY KEY("provider","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "organization_entitlement" (
	"organization_id" text NOT NULL,
	"entitlement" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_entitlement_organization_id_entitlement_pk" PRIMARY KEY("organization_id","entitlement")
);
--> statement-breakpoint
CREATE TABLE "organization_subscription" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "organization_subscription_provider_idx" ON "organization_subscription" USING btree ("provider_subscription_id");
--> statement-breakpoint
ALTER TABLE "organization_subscription" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_subscription" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_subscription_tenant" ON "organization_subscription" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
ALTER TABLE "organization_entitlement" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_entitlement" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_entitlement_tenant" ON "organization_entitlement" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
REVOKE ALL ON "organization_subscription", "organization_entitlement", "billing_provider_event" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_subscription", "organization_entitlement" TO trestle_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "billing_provider_event" TO trestle_app;
