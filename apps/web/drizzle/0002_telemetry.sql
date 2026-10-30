CREATE TABLE "owner_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_ref" text NOT NULL,
	"action" text NOT NULL,
	"target_ref" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetry_event" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"match_id" text NOT NULL,
	"game" text NOT NULL,
	"level" text NOT NULL,
	"persona" text NOT NULL,
	"device" text DEFAULT 'unknown' NOT NULL,
	"duration_ms" integer,
	"outcome" text,
	"reason" text,
	"training_basis" text NOT NULL,
	"opted_out" boolean DEFAULT false NOT NULL,
	"player_ref" text NOT NULL,
	"player_kind" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "telemetry_event_at_idx" ON "telemetry_event" USING btree ("at");--> statement-breakpoint
CREATE INDEX "telemetry_event_match_idx" ON "telemetry_event" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "telemetry_event_player_idx" ON "telemetry_event" USING btree ("player_ref");