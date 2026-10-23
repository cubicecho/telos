-- Check lanes are gone: telos runs no commands on the runner's host. A check
-- lane already had no agent, so dropping its command leaves an ordinary lane
-- that keeps its todos and no longer runs anything.
ALTER TABLE "lanes" DROP CONSTRAINT "ck_lanes_check_timeout";--> statement-breakpoint
ALTER TABLE "lanes" DROP COLUMN "check_command";--> statement-breakpoint
ALTER TABLE "lanes" DROP COLUMN "check_timeout_seconds";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "check_command";
