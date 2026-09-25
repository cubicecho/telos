-- Announces a change to a board, so a person watching it sees what an agent,
-- an MCP client or another tab did without reloading (server/src/board-events.ts).
--
-- A trigger rather than a publish in each resolver: a board changes through
-- generated CRUD, hand-written mutations, the runner and the MCP door, and a
-- trigger is the one place none of them can forget. The payload is only whose
-- board and which table; a client refetches through the scoped queries, so
-- nothing is disclosed here that tenancy would hide.
--
-- NOTIFY is delivered on commit and Postgres folds identical payloads within a
-- transaction, so reordering ten lanes is one notice, not ten.
--
-- TG_ARGV[0] names where the project is: 'project_id' on the row itself, 'id'
-- for a project, or 'todo_id' for a row that hangs off a todo.
CREATE OR REPLACE FUNCTION notify_board_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed jsonb;
  project text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed := to_jsonb(OLD);
  ELSE
    changed := to_jsonb(NEW);
  END IF;
  IF TG_ARGV[0] = 'todo_id' THEN
    SELECT project_id::text INTO project FROM todos WHERE id = (changed ->> 'todo_id')::uuid;
  ELSE
    project := changed ->> TG_ARGV[0];
  END IF;
  IF project IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify(
    'telos_board',
    json_build_object('userId', changed ->> 'user_id', 'projectId', project, 'table', TG_TABLE_NAME)::text
  );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER projects_board_notify AFTER INSERT OR UPDATE OR DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION notify_board_change('id');
--> statement-breakpoint
CREATE TRIGGER lanes_board_notify AFTER INSERT OR UPDATE OR DELETE ON lanes
  FOR EACH ROW EXECUTE FUNCTION notify_board_change('project_id');
--> statement-breakpoint
CREATE TRIGGER todos_board_notify AFTER INSERT OR UPDATE OR DELETE ON todos
  FOR EACH ROW EXECUTE FUNCTION notify_board_change('project_id');
--> statement-breakpoint
-- A run's heartbeat and token counts change every few seconds while it works;
-- the board shows only that one is running and how it ended.
CREATE TRIGGER runs_board_notify AFTER INSERT OR DELETE OR UPDATE OF status ON runs
  FOR EACH ROW EXECUTE FUNCTION notify_board_change('project_id');
--> statement-breakpoint
CREATE TRIGGER todo_labels_board_notify AFTER INSERT OR UPDATE OR DELETE ON todo_labels
  FOR EACH ROW EXECUTE FUNCTION notify_board_change('todo_id');
--> statement-breakpoint
CREATE TRIGGER todo_dependencies_board_notify AFTER INSERT OR UPDATE OR DELETE ON todo_dependencies
  FOR EACH ROW EXECUTE FUNCTION notify_board_change('todo_id');
--> statement-breakpoint
CREATE TRIGGER todo_notes_board_notify AFTER INSERT OR UPDATE OR DELETE ON todo_notes
  FOR EACH ROW EXECUTE FUNCTION notify_board_change('todo_id');
