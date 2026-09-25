CREATE TABLE "draft_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_draft_messages_role" CHECK ("role" in ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid,
	"title" text DEFAULT '' NOT NULL,
	"brief" text DEFAULT '' NOT NULL,
	"waiting_since" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"error" text,
	"todo_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_draft_messages_user_id" ON "draft_messages" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_draft_messages_draft_id" ON "draft_messages" ("draft_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_drafts_user_id" ON "drafts" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_drafts_project_id" ON "drafts" ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_drafts_agent_id" ON "drafts" ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_drafts_todo_id" ON "drafts" ("todo_id");--> statement-breakpoint
CREATE INDEX "idx_drafts_waiting" ON "drafts" ("waiting_since") WHERE waiting_since is not null;--> statement-breakpoint
ALTER TABLE "draft_messages" ADD CONSTRAINT "draft_messages_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "draft_messages" ADD CONSTRAINT "draft_messages_draft_id_drafts_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_todo_id_todos_id_fkey" FOREIGN KEY ("todo_id") REFERENCES "todos"("id") ON DELETE SET NULL;