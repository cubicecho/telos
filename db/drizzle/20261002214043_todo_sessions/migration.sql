CREATE TABLE "todo_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"todo_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "ck_todo_sessions_attempts" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "idx_todo_sessions_user_id" ON "todo_sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_todo_sessions_agent_id" ON "todo_sessions" ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_todo_sessions_todo_agent" ON "todo_sessions" ("todo_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_todo_sessions_deleted_at" ON "todo_sessions" ("deleted_at") WHERE deleted_at IS NOT NULL;--> statement-breakpoint
ALTER TABLE "todo_sessions" ADD CONSTRAINT "todo_sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todo_sessions" ADD CONSTRAINT "todo_sessions_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;--> statement-breakpoint
-- The sessions already opened: every agent that has worked a todo still here.
INSERT INTO "todo_sessions" ("user_id", "todo_id", "agent_id", "opened_at")
SELECT r.user_id, r.todo_id, r.agent_id, min(r.started_at)
FROM runs r
WHERE r.kind = 'todo' AND r.todo_id IS NOT NULL AND r.agent_id IS NOT NULL
GROUP BY r.user_id, r.todo_id, r.agent_id;
--> statement-breakpoint
-- A deleted todo's sessions are owed a `sessionDelete`, whichever delete took
-- it: its own, its project's, or a parent's. The row outlives the todo so the
-- runner can tell the agent's servers.
CREATE FUNCTION end_todo_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE todo_sessions SET deleted_at = now() WHERE todo_id = OLD.id AND deleted_at IS NULL;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER todos_end_sessions AFTER DELETE ON todos FOR EACH ROW EXECUTE FUNCTION end_todo_sessions();
