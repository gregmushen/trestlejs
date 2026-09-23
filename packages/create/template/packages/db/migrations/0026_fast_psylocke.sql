CREATE TABLE "support_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"operator_id" text NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	"correlation_id" text NOT NULL,
	CONSTRAINT "support_session_window_check" CHECK ("support_session"."expires_at" > "support_session"."started_at" AND "support_session"."expires_at" <= "support_session"."started_at" + interval '4 hours'),
	CONSTRAINT "support_session_end_check" CHECK (("support_session"."ended_at" IS NULL AND "support_session"."ended_by" IS NULL) OR ("support_session"."ended_at" IS NOT NULL AND "support_session"."ended_by" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "support_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "support_session_organization_idx" ON "support_session" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_session_open_operator_uidx" ON "support_session" USING btree ("operator_id") WHERE "support_session"."ended_at" is null;--> statement-breakpoint
CREATE POLICY "support_session_platform_select" ON "support_session" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
CREATE POLICY "support_session_platform_insert" ON "support_session" AS PERMISSIVE FOR INSERT TO "trestle_platform" WITH CHECK ("support_session"."ended_at" IS NULL);--> statement-breakpoint
CREATE POLICY "support_session_platform_end" ON "support_session" AS PERMISSIVE FOR UPDATE TO "trestle_platform" USING ("support_session"."ended_at" IS NULL) WITH CHECK ("support_session"."ended_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "support_session" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Support sessions belong to the platform: tenant runtimes have no access, and the platform
-- starts and ends sessions but never deletes one or changes who, where, why, or for how long.
REVOKE ALL ON "support_session" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON "support_session" TO trestle_platform;--> statement-breakpoint
GRANT UPDATE ("ended_at", "ended_by") ON "support_session" TO trestle_platform;
