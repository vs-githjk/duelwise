CREATE TABLE "agent_version" (
	"game" text NOT NULL,
	"version" text NOT NULL,
	"parent" text,
	"status" text NOT NULL,
	"promoted_at" timestamp with time zone,
	"measured" jsonb,
	CONSTRAINT "agent_version_game_version_pk" PRIMARY KEY("game","version")
);
--> statement-breakpoint
CREATE TABLE "guest" (
	"id" text PRIMARY KEY NOT NULL,
	"training_allowed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match" (
	"id" text PRIMARY KEY NOT NULL,
	"game" text NOT NULL,
	"user_id" text,
	"guest_id" text,
	"agent_version" text NOT NULL,
	"level" text NOT NULL,
	"seed" bigint NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"result" jsonb,
	"record" "bytea",
	"record_valid" boolean,
	"invalid_reason" text,
	"filter_flags" jsonb,
	"training_allowed" boolean DEFAULT true NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"training_allowed" boolean DEFAULT true NOT NULL,
	"notice_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rating" (
	"user_id" text NOT NULL,
	"game" text NOT NULL,
	"elo" integer NOT NULL,
	"games" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rating_user_id_game_pk" PRIMARY KEY("user_id","game")
);
--> statement-breakpoint
CREATE TABLE "training_run" (
	"id" text PRIMARY KEY NOT NULL,
	"game" text NOT NULL,
	"challenger" text NOT NULL,
	"champion" text NOT NULL,
	"gate" jsonb,
	"promoted" boolean DEFAULT false NOT NULL,
	"human_matches_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
