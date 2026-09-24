CREATE TABLE "billing_subscription_ownership" (
	"provider" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscription_ownership_pk" PRIMARY KEY("provider","provider_subscription_id")
);
--> statement-breakpoint
-- A conflicting historical owner aborts migration rather than silently
-- choosing a tenant for an already-projected provider subscription.
-- The migration owner needs to see every existing tenant row. NO FORCE only
-- exempts the table owner; trestle_app remains subject to its tenant policy.
ALTER TABLE "organization_subscription" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO "billing_subscription_ownership" ("provider", "provider_subscription_id", "organization_id")
SELECT "provider", "provider_subscription_id", "organization_id"
FROM "organization_subscription" WHERE "provider_subscription_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_subscription" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_subscription_ownership" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_subscription_ownership" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "billing_subscription_ownership_tenant" ON "billing_subscription_ownership" TO trestle_app
USING ("organization_id" = current_setting('app.organization_id', true))
WITH CHECK ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
REVOKE ALL ON "billing_subscription_ownership" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON "billing_subscription_ownership" TO trestle_app;
