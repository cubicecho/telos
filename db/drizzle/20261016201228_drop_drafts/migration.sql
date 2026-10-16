-- Drafts are gone, and their replies with them: a run is a todo's again.
DELETE FROM "runs" WHERE "kind" = 'draft';--> statement-breakpoint
ALTER TABLE "draft_messages" DROP CONSTRAINT "draft_messages_draft_id_drafts_id_fkey";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_draft_id_drafts_id_fkey";--> statement-breakpoint
DROP TABLE "draft_messages";--> statement-breakpoint
DROP TABLE "drafts";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "ck_runs_kind";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "ck_runs_owner";--> statement-breakpoint
DROP INDEX "idx_runs_draft_id";--> statement-breakpoint
DROP INDEX "uq_runs_draft_running";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "draft_id";--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "todo_id" SET NOT NULL;