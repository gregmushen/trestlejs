CREATE TABLE "artifact_maintenance_cursor" (
	"name" text PRIMARY KEY NOT NULL,
	"after_organization_id" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
