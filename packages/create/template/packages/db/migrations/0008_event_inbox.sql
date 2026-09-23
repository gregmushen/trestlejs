CREATE TABLE "event_inbox" (
  "idempotency_key" text PRIMARY KEY NOT NULL,
  "event_id" text NOT NULL,
  "event_name" text NOT NULL,
  "status" text DEFAULT 'processing' NOT NULL,
  "claim_token" text,
  "leased_until" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  CONSTRAINT "event_inbox_status_check" CHECK ("status" IN ('processing', 'completed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "event_inbox_event_id_uidx" ON "event_inbox" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX "event_inbox_status_lease_idx" ON "event_inbox" USING btree ("status", "leased_until");
--> statement-breakpoint
REVOKE ALL ON "event_inbox" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "event_inbox" TO trestle_app;
