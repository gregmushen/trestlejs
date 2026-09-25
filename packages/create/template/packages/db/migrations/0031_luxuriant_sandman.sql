CREATE POLICY "application_role_assignment_platform_select" ON "application_role_assignment" AS PERMISSIVE FOR SELECT TO "trestle_platform" USING (true);--> statement-breakpoint
-- The platform admin reads application-role assignments to list role holders and explain access.
GRANT SELECT ("id", "organization_id", "user_id", "role", "granted_by", "granted_at", "revoked_at", "revoked_by") ON "application_role_assignment" TO trestle_platform;--> statement-breakpoint
-- Email delivery status only: provider message IDs, statuses, and times. There are no bodies or recipients in this table.
GRANT SELECT ("id", "email_delivery_id", "status", "occurred_at", "received_at") ON "email_delivery_event" TO trestle_platform;
