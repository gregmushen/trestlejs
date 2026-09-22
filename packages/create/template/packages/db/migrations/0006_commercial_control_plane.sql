ALTER TABLE "organization_subscription" ADD COLUMN "plan_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE "organization_entitlement_override" (
  "organization_id" text NOT NULL,
  "entitlement" text NOT NULL,
  "enabled" boolean NOT NULL,
  "reason" text NOT NULL,
  "author_id" text NOT NULL,
  "effective_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_entitlement_override_pk" PRIMARY KEY("organization_id", "entitlement", "effective_at")
);
--> statement-breakpoint
ALTER TABLE "organization_entitlement_override" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_entitlement_override" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_entitlement_override_tenant" ON "organization_entitlement_override" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
REVOKE ALL ON "organization_entitlement_override" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_entitlement_override" TO trestle_app;
