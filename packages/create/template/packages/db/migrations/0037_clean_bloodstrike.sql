CREATE TABLE "scheduled_job" (
	"name" text PRIMARY KEY NOT NULL,
	"lease_token" text,
	"leased_until" timestamp with time zone,
	"completed_due_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_started_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_job_name_check" CHECK ("scheduled_job"."name" ~ '^[a-z][a-z0-9._-]{0,99}$'),
	CONSTRAINT "scheduled_job_failures_check" CHECK ("scheduled_job"."failures" >= 0)
);
--> statement-breakpoint
-- Application due-work job leases. The runtime role reads and updates lease
-- state; it never deletes rows, so a job's completed due slot is never forgotten.
GRANT SELECT, INSERT, UPDATE ON "scheduled_job" TO trestle_app;
