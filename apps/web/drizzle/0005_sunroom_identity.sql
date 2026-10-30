ALTER TABLE "guest" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "guest" ADD COLUMN "show_on_leaderboard" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "match" ADD COLUMN "call" text;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "display_name" text;--> statement-breakpoint
CREATE INDEX "match_game_level_finished_idx" ON "match" USING btree ("game","level","finished_at");