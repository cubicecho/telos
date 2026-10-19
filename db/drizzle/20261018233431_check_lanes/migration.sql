ALTER TABLE "lanes" ADD COLUMN "check_command" text;--> statement-breakpoint
ALTER TABLE "lanes" ADD COLUMN "check_timeout_seconds" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "check_command" text;--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "ck_lanes_check_timeout" CHECK ("check_timeout_seconds" IS NULL OR "check_timeout_seconds" > 0);