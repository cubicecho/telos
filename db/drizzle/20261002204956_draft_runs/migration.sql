ALTER TABLE "runs" ADD COLUMN "kind" text DEFAULT 'todo' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "drafts" DROP COLUMN "lease_expires_at";--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "todo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "contract" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_runs_draft_id" ON "runs" ("draft_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runs_draft_running" ON "runs" ("draft_id") WHERE status = 'running';--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_draft_id_drafts_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "ck_runs_kind" CHECK ("kind" in ('todo', 'draft'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "ck_runs_owner" CHECK (("kind" = 'todo' and "todo_id" is not null and "draft_id" is null and "contract" is not null)
        or ("kind" = 'draft' and "draft_id" is not null and "todo_id" is null and "contract" is null));