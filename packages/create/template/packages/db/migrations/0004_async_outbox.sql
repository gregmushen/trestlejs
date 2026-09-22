CREATE TABLE "outbox_message" (
	"id" text PRIMARY KEY NOT NULL,
	"event_name" text NOT NULL,
	"schema_version" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"causation_id" text,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"leased_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_message_idempotency_uidx" ON "outbox_message" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "outbox_message_delivery_idx" ON "outbox_message" USING btree ("status","available_at");
--> statement-breakpoint
REVOKE ALL ON "outbox_message" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox_message" TO trestle_app;
