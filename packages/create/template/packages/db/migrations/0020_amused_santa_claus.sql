CREATE TABLE "application_role_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text
);
--> statement-breakpoint
ALTER TABLE "application_role_assignment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_role_assignment" ADD CONSTRAINT "application_role_assignment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_role_assignment_active_uidx" ON "application_role_assignment" USING btree ("organization_id","user_id","role") WHERE "application_role_assignment"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "application_role_assignment_user_idx" ON "application_role_assignment" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE POLICY "application_role_assignment_tenant" ON "application_role_assignment" AS PERMISSIVE FOR ALL TO "trestle_app" USING ("application_role_assignment"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("application_role_assignment"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
ALTER TABLE "application_role_assignment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "application_role_assignment" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "application_role_assignment" TO trestle_app;--> statement-breakpoint
-- Carry authority model 2 application roles forward: contributor becomes editor and viewer
-- becomes reader. member.application_role is retained, unused, for rollback until a later
-- release drops it. Forced RLS is relaxed for the table owner only during the backfill.
ALTER TABLE "application_role_assignment" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "application_role_assignment" ("organization_id", "user_id", "role", "granted_by")
SELECT "organization_id", "user_id", CASE "application_role" WHEN 'contributor' THEN 'editor' ELSE 'reader' END, 'system:migration'
FROM "member" WHERE "application_role" IN ('contributor', 'viewer')
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "application_role_assignment" FORCE ROW LEVEL SECURITY;
