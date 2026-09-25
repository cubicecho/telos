CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"todo_id" uuid NOT NULL,
	"run_id" uuid,
	"location" text NOT NULL,
	"source" text NOT NULL,
	"action" text DEFAULT 'created' NOT NULL,
	"server_slug" text,
	"tool" text,
	"title" text,
	"description" text,
	"media_type" text,
	"size_bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_artifacts_source" CHECK ("source" in ('declared', 'detected')),
	CONSTRAINT "ck_artifacts_action" CHECK ("action" in ('created', 'updated', 'moved', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "events" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_artifacts_user_id" ON "artifacts" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_artifacts_project_id" ON "artifacts" ("project_id");--> statement-breakpoint
CREATE INDEX "idx_artifacts_todo_id" ON "artifacts" ("todo_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_artifacts_run_id" ON "artifacts" ("run_id");--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_todo_id_todos_id_fkey" FOREIGN KEY ("todo_id") REFERENCES "todos"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL;