CREATE TABLE "capability_status" (
	"environment" text NOT NULL,
	"capability_id" text NOT NULL,
	"label" text NOT NULL,
	"state" text NOT NULL,
	"healthy" boolean NOT NULL,
	"mode" text,
	"message" text,
	"repair" text,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_status_environment_capability_id_pk" PRIMARY KEY("environment","capability_id")
);
--> statement-breakpoint
CREATE TABLE "email_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"template" text NOT NULL,
	"recipient_masked" text NOT NULL,
	"recipient_count" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"failure_category" text,
	"correlation_id" text,
	"organization_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
REVOKE ALL ON "capability_status", "email_delivery" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "capability_status" TO trestle_app;
--> statement-breakpoint
GRANT INSERT ON "email_delivery" TO trestle_app;
--> statement-breakpoint
GRANT SELECT ON "capability_status", "email_delivery" TO trestle_platform;
