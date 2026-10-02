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
