CREATE TABLE "match_report" (
	"match_id" text PRIMARY KEY NOT NULL,
	"elo_before" integer,
	"elo_after" integer,
	"provisional" boolean DEFAULT false NOT NULL,
	"link_public" boolean DEFAULT true NOT NULL,
	"show_name" boolean DEFAULT false NOT NULL,
	"built" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
