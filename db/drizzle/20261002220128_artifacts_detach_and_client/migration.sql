ALTER TABLE "artifacts" ADD COLUMN "todo_title" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "actor_kind" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "actor_key_id" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "todo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_todo_id_todos_id_fkey", ADD CONSTRAINT "artifacts_todo_id_todos_id_fkey" FOREIGN KEY ("todo_id") REFERENCES "todos"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "ck_artifacts_source", ADD CONSTRAINT "ck_artifacts_source" CHECK ("source" in ('declared', 'detected', 'client'));
--> statement-breakpoint
-- An artifact outlives its todo. Before a todo is deleted, whichever write
-- deletes it, its artifacts take down what it was called; the foreign key then
-- sets their todo_id to null. An artifact that is a note on the todo
-- (`telos:note/<id>`) goes instead, since the note it points at goes too.
CREATE FUNCTION detach_artifacts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM artifacts WHERE todo_id = OLD.id AND location LIKE 'telos:note/%';
  UPDATE artifacts SET todo_title = OLD.title WHERE todo_id = OLD.id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER todos_detach_artifacts BEFORE DELETE ON todos FOR EACH ROW EXECUTE FUNCTION detach_artifacts();
