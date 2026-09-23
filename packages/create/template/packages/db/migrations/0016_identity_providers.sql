CREATE TABLE "directory_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"type" text NOT NULL,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_role_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"connection_id" text NOT NULL,
	"external_group_id" text NOT NULL,
	"target_plane" text NOT NULL,
	"target_role" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_role_mapping_plane_check" CHECK ("external_role_mapping"."target_plane" in ('organization', 'application')),
	CONSTRAINT "external_role_mapping_owner_check" CHECK (not ("external_role_mapping"."target_plane" = 'organization' and "external_role_mapping"."target_role" = 'owner'))
);
--> statement-breakpoint
CREATE TABLE "identity_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"domain" text,
	"state" text DEFAULT 'active' NOT NULL,
	"last_event_at" timestamp with time zone,
	"last_error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_connection_kind_check" CHECK ("identity_connection"."kind" in ('sso', 'directory'))
);
--> statement-breakpoint
CREATE TABLE "scim_connection_binding" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"connection_key" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decommissioned_at" timestamp with time zone,
	"decommission_status" text NOT NULL,
	"decommission_cursor_user_id" text,
	"decommission_reconciled_user_count" integer NOT NULL,
	"decommission_batch_count" integer NOT NULL,
	"decommission_revision" integer NOT NULL,
	"decommission_completed_at" timestamp with time zone,
	"decommission_lease_id" text,
	"decommission_lease_expires_at" timestamp with time zone,
	CONSTRAINT "scim_connection_binding_connection_key_unique" UNIQUE("connection_key")
);
--> statement-breakpoint
CREATE TABLE "scim_group" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"revision" integer NOT NULL,
	"display_name" text NOT NULL,
	"display_name_key" text NOT NULL,
	"external_id" text,
	"external_id_key" text,
	"order_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_group_display_name_key_unique" UNIQUE("display_name_key"),
	CONSTRAINT "scim_group_external_id_key_unique" UNIQUE("external_id_key"),
	CONSTRAINT "scim_group_order_key_unique" UNIQUE("order_key")
);
--> statement-breakpoint
CREATE TABLE "scim_group_member" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"group_id" text NOT NULL,
	"scim_user_id" text NOT NULL,
	"membership_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_group_member_membership_key_unique" UNIQUE("membership_key")
);
--> statement-breakpoint
CREATE TABLE "scim_identity_tombstone" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"external_id" text NOT NULL,
	"external_id_key" text NOT NULL,
	"user_id" text NOT NULL,
	"profile" text NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_identity_tombstone_external_id_key_unique" UNIQUE("external_id_key")
);
--> statement-breakpoint
CREATE TABLE "scim_managed_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"creation_request_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"status" text NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"decommission_started_at" timestamp with time zone,
	"decommission_started_by" text,
	"decommissioned_at" timestamp with time zone,
	"decommissioned_by" text,
	CONSTRAINT "scim_managed_connection_creation_request_id_unique" UNIQUE("creation_request_id"),
	CONSTRAINT "scim_managed_connection_connection_id_unique" UNIQUE("connection_id")
);
--> statement-breakpoint
CREATE TABLE "scim_managed_connection_event" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_record_id" text NOT NULL,
	"event_key" text NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"actor_id" text NOT NULL,
	"credential_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_managed_connection_event_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "scim_managed_credential" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_record_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"token_digest" text NOT NULL,
	"hash_version" text NOT NULL,
	"active_slot_key" text NOT NULL,
	"status" text NOT NULL,
	"serialized_scopes" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"decommissioned_at" timestamp with time zone,
	CONSTRAINT "scim_managed_credential_credential_id_unique" UNIQUE("credential_id"),
	CONSTRAINT "scim_managed_credential_active_slot_key_unique" UNIQUE("active_slot_key")
);
--> statement-breakpoint
CREATE TABLE "scim_projection_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"scim_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_value" text,
	"role" text NOT NULL,
	"grant_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_projection_grant_grant_key_unique" UNIQUE("grant_key")
);
--> statement-breakpoint
CREATE TABLE "scim_subject" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"profile_source_id" text,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_subject_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "scim_user" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connection_user_key" text NOT NULL,
	"user_name" text NOT NULL,
	"user_name_key" text NOT NULL,
	"primary_email" text NOT NULL,
	"work_email_value_index" text NOT NULL,
	"email_value_index" text NOT NULL,
	"display_name" text NOT NULL,
	"formatted_name" text NOT NULL,
	"given_name" text,
	"family_name" text,
	"serialized_emails" text NOT NULL,
	"serialized_attributes" text,
	"external_id" text,
	"external_id_key" text,
	"active" boolean NOT NULL,
	"order_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_user_connection_user_key_unique" UNIQUE("connection_user_key"),
	CONSTRAINT "scim_user_user_name_key_unique" UNIQUE("user_name_key"),
	CONSTRAINT "scim_user_external_id_key_unique" UNIQUE("external_id_key"),
	CONSTRAINT "scim_user_order_key_unique" UNIQUE("order_key")
);
--> statement-breakpoint
CREATE TABLE "sso_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" text,
	"provider_id" text NOT NULL,
	"organization_id" text,
	"domain" text NOT NULL,
	"domain_verified" boolean DEFAULT false,
	CONSTRAINT "sso_provider_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
ALTER TABLE "application_role_assignment" ADD COLUMN "source_provider" text;--> statement-breakpoint
ALTER TABLE "application_role_assignment" ADD COLUMN "source_connection_id" text;--> statement-breakpoint
ALTER TABLE "application_role_assignment" ADD COLUMN "source_group_id" text;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "role_source" text;--> statement-breakpoint
ALTER TABLE "usage_aggregate" ADD COLUMN "reported_quantity" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_aggregate" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "usage_aggregate" ADD COLUMN "provider_quantity" bigint;--> statement-breakpoint
ALTER TABLE "usage_aggregate" ADD COLUMN "provider_balance" double precision;--> statement-breakpoint
ALTER TABLE "usage_aggregate" ADD COLUMN "provider_has_access" boolean;--> statement-breakpoint
ALTER TABLE "usage_aggregate" ADD COLUMN "provider_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_attempt" ADD COLUMN "provider_reference" text;--> statement-breakpoint
ALTER TABLE "scim_group_member" ADD CONSTRAINT "scim_group_member_group_id_scim_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_group"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_member" ADD CONSTRAINT "scim_group_member_scim_user_id_scim_user_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_identity_tombstone" ADD CONSTRAINT "scim_identity_tombstone_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_managed_connection_event" ADD CONSTRAINT "scim_managed_connection_event_connection_record_id_scim_managed_connection_id_fk" FOREIGN KEY ("connection_record_id") REFERENCES "public"."scim_managed_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_managed_credential" ADD CONSTRAINT "scim_managed_credential_connection_record_id_scim_managed_connection_id_fk" FOREIGN KEY ("connection_record_id") REFERENCES "public"."scim_managed_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_projection_grant" ADD CONSTRAINT "scim_projection_grant_scim_user_id_scim_user_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_projection_grant" ADD CONSTRAINT "scim_projection_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_subject" ADD CONSTRAINT "scim_subject_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_user" ADD CONSTRAINT "scim_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "directory_event_organization_idx" ON "directory_event" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_role_mapping_uidx" ON "external_role_mapping" USING btree ("organization_id","provider","connection_id","external_group_id","target_plane","target_role");--> statement-breakpoint
CREATE INDEX "external_role_mapping_connection_idx" ON "external_role_mapping" USING btree ("provider","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_connection_external_uidx" ON "identity_connection" USING btree ("provider","kind","external_id",coalesce("domain", ''));--> statement-breakpoint
CREATE INDEX "identity_connection_domain_idx" ON "identity_connection" USING btree ("provider","kind","domain");--> statement-breakpoint
CREATE INDEX "identity_connection_organization_idx" ON "identity_connection" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "scim_connection_binding_connection_id_idx" ON "scim_connection_binding" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_group_connection_id_idx" ON "scim_group" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_group_provisioning_domain_id_idx" ON "scim_group" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_group_member_connection_id_idx" ON "scim_group_member" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_group_member_group_id_idx" ON "scim_group_member" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "scim_group_member_scim_user_id_idx" ON "scim_group_member" USING btree ("scim_user_id");--> statement-breakpoint
CREATE INDEX "scim_identity_tombstone_connection_id_idx" ON "scim_identity_tombstone" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_identity_tombstone_provisioning_domain_id_idx" ON "scim_identity_tombstone" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_identity_tombstone_user_id_idx" ON "scim_identity_tombstone" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scim_managed_connection_provisioning_domain_id_idx" ON "scim_managed_connection" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_managed_connection_event_connection_record_id_idx" ON "scim_managed_connection_event" USING btree ("connection_record_id");--> statement-breakpoint
CREATE INDEX "scim_managed_credential_connection_record_id_idx" ON "scim_managed_credential" USING btree ("connection_record_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grant_connection_id_idx" ON "scim_projection_grant" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grant_provisioning_domain_id_idx" ON "scim_projection_grant" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grant_scim_user_id_idx" ON "scim_projection_grant" USING btree ("scim_user_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grant_user_id_idx" ON "scim_projection_grant" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scim_subject_profile_source_id_idx" ON "scim_subject" USING btree ("profile_source_id");--> statement-breakpoint
CREATE INDEX "scim_user_connection_id_idx" ON "scim_user" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_user_provisioning_domain_id_idx" ON "scim_user" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_user_user_id_idx" ON "scim_user" USING btree ("user_id");--> statement-breakpoint
-- Trestle identity bindings, mappings, and directory events are tenant data.
ALTER TABLE "identity_connection" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "identity_connection" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "external_role_mapping" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "external_role_mapping" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "directory_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "directory_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "identity_connection_tenant" ON "identity_connection" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "identity_connection_platform" ON "identity_connection" FOR SELECT TO trestle_platform USING (true);
--> statement-breakpoint
CREATE POLICY "external_role_mapping_tenant" ON "external_role_mapping" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "external_role_mapping_platform" ON "external_role_mapping" FOR SELECT TO trestle_platform USING (true);
--> statement-breakpoint
CREATE POLICY "directory_event_tenant" ON "directory_event" TO trestle_app USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "directory_event_platform" ON "directory_event" FOR SELECT TO trestle_platform USING (true);
--> statement-breakpoint
REVOKE ALL ON "identity_connection", "external_role_mapping", "directory_event" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "identity_connection", "external_role_mapping" TO trestle_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "directory_event" TO trestle_app;
--> statement-breakpoint
GRANT SELECT ON "identity_connection", "external_role_mapping", "directory_event" TO trestle_platform;
--> statement-breakpoint
-- Better Auth SSO and SCIM tables belong to the auth runtime. Credentials,
-- token digests, IdP configuration, and provisioned emails stay out of reach;
-- the platform reads connection status only.
REVOKE ALL ON "sso_provider", "scim_managed_connection", "scim_managed_credential", "scim_managed_connection_event", "scim_connection_binding", "scim_identity_tombstone", "scim_subject", "scim_user", "scim_projection_grant", "scim_group", "scim_group_member" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ("id", "issuer", "provider_id", "organization_id", "domain", "domain_verified") ON "sso_provider" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT ("id", "connection_id", "provisioning_domain_id", "status", "created_at", "created_by", "decommission_started_at", "decommissioned_at") ON "scim_managed_connection" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT ("id", "connection_record_id", "credential_id", "status", "serialized_scopes", "expires_at", "created_at", "created_by", "last_used_at", "revoked_at") ON "scim_managed_credential" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT ("id", "connection_id", "provisioning_domain_id", "user_id", "active", "created_at", "updated_at") ON "scim_user" TO trestle_platform;
--> statement-breakpoint
GRANT SELECT ("id", "connection_id", "provisioning_domain_id", "display_name", "created_at", "updated_at") ON "scim_group" TO trestle_platform;
--> statement-breakpoint
-- The metering runner finds usage the provider has not accepted yet, across tenants,
-- then reports and records it on each tenant's RLS-bound connection.
CREATE OR REPLACE FUNCTION trestle_due_usage_reports(p_limit integer)
RETURNS TABLE (organization_id text, feature_code text, period_start timestamptz, period_end timestamptz, quantity bigint, reported_quantity bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.organization_id, u.feature_code, u.period_start, u.period_end, u.quantity, u.reported_quantity FROM public.usage_aggregate u
   WHERE u.quantity > u.reported_quantity
   ORDER BY u.period_start LIMIT least(greatest(p_limit, 1), 500)
$$;
--> statement-breakpoint
-- Current periods to reconcile against the provider's own figures.
CREATE OR REPLACE FUNCTION trestle_current_usage_periods(p_limit integer)
RETURNS TABLE (organization_id text, feature_code text, period_start timestamptz, period_end timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.organization_id, u.feature_code, u.period_start, u.period_end FROM public.usage_aggregate u
   WHERE u.period_end > now()
   ORDER BY u.provider_observed_at NULLS FIRST LIMIT least(greatest(p_limit, 1), 500)
$$;
--> statement-breakpoint
-- Inbound directory events name a provider organization or directory; this
-- resolves the bound Trestle organization without granting cross-tenant reads.
CREATE OR REPLACE FUNCTION trestle_resolve_identity_connection(p_provider text, p_kind text, p_external_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.organization_id FROM public.identity_connection c
   WHERE c.provider = p_provider AND c.kind = p_kind AND c.external_id = p_external_id AND c.state = 'active'
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION trestle_due_usage_reports(integer), trestle_current_usage_periods(integer), trestle_resolve_identity_connection(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trestle_due_usage_reports(integer), trestle_current_usage_periods(integer), trestle_resolve_identity_connection(text, text, text) TO trestle_app;
--> statement-breakpoint
-- A non-superuser owner is subject to forced RLS. SCIM projections run inside
-- the auth runtime's transaction, so it may write only directory-owned
-- application roles and directory audit events, and read mappings.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY "application_role_assignment_directory_owner" ON "application_role_assignment" TO %I USING (source_provider IS NOT NULL) WITH CHECK (source_provider IS NOT NULL)', current_user);
    EXECUTE format('CREATE POLICY "external_role_mapping_owner" ON "external_role_mapping" FOR SELECT TO %I USING (true)', current_user);
    EXECUTE format('CREATE POLICY "identity_connection_owner" ON "identity_connection" FOR SELECT TO %I USING (true)', current_user);
    EXECUTE format('CREATE POLICY "usage_aggregate_owner" ON "usage_aggregate" FOR SELECT TO %I USING (true)', current_user);
    EXECUTE format('CREATE POLICY "audit_event_directory_owner" ON "audit_event" FOR INSERT TO %I WITH CHECK (name LIKE %L)', current_user, 'directory.%');
  END IF;
END
$$;
