CREATE TABLE "friend_result" (
	"id" text PRIMARY KEY NOT NULL,
	"game" text NOT NULL,
	"player_a" text NOT NULL,
	"player_b" text NOT NULL,
	"name_a" text NOT NULL,
	"name_b" text NOT NULL,
	"winner" text,
	"finished_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "friend_result_a_idx" ON "friend_result" USING btree ("player_a","finished_at");--> statement-breakpoint
CREATE INDEX "friend_result_b_idx" ON "friend_result" USING btree ("player_b","finished_at");