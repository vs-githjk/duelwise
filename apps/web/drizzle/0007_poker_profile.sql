ALTER TABLE "guest" ADD COLUMN "poker_profile_allowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "poker_profile_allowed" boolean DEFAULT true NOT NULL;