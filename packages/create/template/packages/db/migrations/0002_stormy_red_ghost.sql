CREATE TABLE "email_delivery_event" (
	"id" text PRIMARY KEY NOT NULL,
	"email_delivery_id" text NOT NULL,
	"status" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
REVOKE ALL ON "email_delivery_event" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON "email_delivery_event" TO trestle_app;
