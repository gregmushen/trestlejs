-- Carry alpha application roles and entitlement overrides into the
-- access-control model, then remove the superseded structures. Forced RLS is
-- relaxed only for the table owner and only for the duration of the backfill.
ALTER TABLE "application_role_assignment" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "application_role_assignment" ("organization_id", "user_id", "role", "granted_by")
SELECT "organization_id", "user_id", CASE "application_role" WHEN 'contributor' THEN 'editor' ELSE 'reader' END, 'system:migration'
FROM "member" WHERE "application_role" IN ('contributor', 'viewer')
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "application_role_assignment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_entitlement_override" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_override" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "subscription_override" ("id", "organization_id", "code", "enabled", "reason", "author", "effective_at", "expires_at", "created_at")
SELECT gen_random_uuid()::text, "organization_id", "entitlement", "enabled", "reason", "author_id", "effective_at", "expires_at", "created_at"
FROM "organization_entitlement_override";--> statement-breakpoint
ALTER TABLE "subscription_override" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "organization_entitlement_override";--> statement-breakpoint
ALTER TABLE "member" DROP COLUMN "application_role";
