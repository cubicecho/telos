ALTER TABLE "artifacts" ADD COLUMN "todo_title" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "actor_kind" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "actor_key_id" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "todo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_todo_id_todos_id_fkey", ADD CONSTRAINT "artifacts_todo_id_todos_id_fkey" FOREIGN KEY ("todo_id") REFERENCES "todos"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "ck_artifacts_source", ADD CONSTRAINT "ck_artifacts_source" CHECK ("source" in ('declared', 'detected', 'client'));