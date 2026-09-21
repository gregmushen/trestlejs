DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trestle_app') THEN
    CREATE ROLE trestle_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "tenant_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tenant_record_organization_idx" ON "tenant_record" USING btree ("organization_id");
--> statement-breakpoint
ALTER TABLE "tenant_record" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_record" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_record_select" ON "tenant_record" FOR SELECT TO trestle_app USING (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_record_insert" ON "tenant_record" FOR INSERT TO trestle_app WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_record_update" ON "tenant_record" FOR UPDATE TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_record_delete" ON "tenant_record" FOR DELETE TO trestle_app USING (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
REVOKE ALL ON "tenant_record" FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO trestle_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_record" TO trestle_app;
