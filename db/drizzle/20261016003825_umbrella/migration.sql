-- A todo an agent split becomes an umbrella: it is never run, and it closes
-- and reopens with its pieces. Written by hand after the generated column:
-- drizzle-kit does not know about triggers.
ALTER TABLE "todos" ADD COLUMN "split_at" timestamp with time zone;--> statement-breakpoint

-- The todos already split are umbrellas from the run that split them, and no
-- longer wait on their pieces through dependencies. Before the history learns
-- of `split_at`, so this is not an edit anyone made.
UPDATE todos t SET split_at = s.at
FROM (
  SELECT n.todo_id, min(n.created_at) AS at FROM todo_notes n
  WHERE n.kind = 'report' AND n.actor_kind = 'agent' AND n.body LIKE 'Split into %'
  GROUP BY n.todo_id
) s
WHERE t.id = s.todo_id AND EXISTS (SELECT 1 FROM todos c WHERE c.parent_id = t.id);
--> statement-breakpoint
DELETE FROM todo_dependencies d
USING todos c
WHERE c.id = d.depends_on_todo_id AND c.parent_id = d.todo_id
  AND EXISTS (SELECT 1 FROM todos u WHERE u.id = d.todo_id AND u.split_at IS NOT NULL);
--> statement-breakpoint

-- The umbrella's own complete and reopen are history, so the history trigger
-- records writes made while one settles. Splitting and unsplitting are edits.
CREATE OR REPLACE FUNCTION record_todo_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_kind text;
  changed text[] := '{}';
  earlier todo_events%ROWTYPE;
BEGIN
  -- Writes made by other triggers are not history, except an umbrella
  -- settling (settle_umbrella), which is a change a reader would look for.
  IF pg_trigger_depth() > 1 AND current_setting('telos.settling', true) IS DISTINCT FROM 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    event_kind := 'create';
  ELSE
    IF NEW.title IS DISTINCT FROM OLD.title THEN changed := changed || 'title'::text; END IF;
    IF NEW.notes IS DISTINCT FROM OLD.notes THEN changed := changed || 'notes'::text; END IF;
    IF NEW.acceptance IS DISTINCT FROM OLD.acceptance THEN changed := changed || 'acceptance'::text; END IF;
    IF NEW.due_at IS DISTINCT FROM OLD.due_at THEN changed := changed || 'dueAt'::text; END IF;
    IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN changed := changed || 'parentId'::text; END IF;
    IF NEW.ai_ignored IS DISTINCT FROM OLD.ai_ignored THEN changed := changed || 'aiIgnored'::text; END IF;
    IF NEW.split_at IS DISTINCT FROM OLD.split_at THEN changed := changed || 'splitAt'::text; END IF;
    IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
      event_kind := 'archive';
    ELSIF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
      event_kind := 'restore';
    ELSIF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL THEN
      event_kind := 'complete';
    ELSIF OLD.completed_at IS NOT NULL AND NEW.completed_at IS NULL THEN
      event_kind := 'reopen';
    ELSIF NEW.lane_id IS DISTINCT FROM OLD.lane_id THEN
      event_kind := 'move';
    ELSIF cardinality(changed) > 0 THEN
      event_kind := 'edit';
    ELSE
      -- Position, or a timestamp: nothing a reader of the history would miss.
      RETURN NULL;
    END IF;
  END IF;
  SELECT * INTO earlier FROM todo_events
  WHERE todo_id = NEW.id AND xmin = pg_current_xact_id()::xid
  ORDER BY at DESC LIMIT 1;
  IF FOUND THEN
    UPDATE todo_events SET
      kind = CASE
        WHEN earlier.kind = 'create' THEN 'create'
        WHEN event_kind IN ('archive', 'restore') THEN event_kind
        WHEN earlier.kind IN ('archive', 'restore') THEN earlier.kind
        WHEN event_kind IN ('complete', 'reopen') THEN event_kind
        WHEN earlier.kind IN ('complete', 'reopen') THEN earlier.kind
        WHEN event_kind = 'move' OR earlier.kind = 'move' THEN 'move'
        ELSE 'edit'
      END,
      to_lane_id = NEW.lane_id,
      fields = ARRAY(
        SELECT f FROM unnest(earlier.fields || changed) WITH ORDINALITY AS u(f, n) GROUP BY f ORDER BY min(n)
      ),
      note_id = coalesce(nullif(current_setting('telos.note_id', true), '')::uuid, earlier.note_id),
      reason = coalesce(nullif(current_setting('telos.reason', true), ''), earlier.reason)
    WHERE id = earlier.id;
    RETURN NULL;
  END IF;
  INSERT INTO todo_events
    (user_id, todo_id, kind, from_lane_id, to_lane_id, fields, actor_kind, actor_key_id, run_id, note_id, reason)
  VALUES (
    NEW.user_id,
    NEW.id,
    event_kind,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.lane_id END,
    NEW.lane_id,
    changed,
    coalesce(nullif(current_setting('telos.actor_kind', true), ''), 'system'),
    nullif(current_setting('telos.actor_key_id', true), '')::uuid,
    nullif(current_setting('telos.run_id', true), '')::uuid,
    nullif(current_setting('telos.note_id', true), '')::uuid,
    nullif(current_setting('telos.reason', true), '')
  );
  RETURN NULL;
END;
$$;--> statement-breakpoint

-- Closes or reopens the umbrella `p_id` to match its pieces, as `system`.
-- A piece archived once completed still counts, as done: a lane that archives
-- on success completes and archives in one write. One archived while open was
-- dropped, and does not count. Closed when it has counted pieces and all of
-- them are completed: moved to the done lane, and archived if it waited in a
-- lane that archives on success. Reopened when an unarchived piece is open
-- again: moved to the first open lane, or off the board if there is none. An
-- archived umbrella is left alone, and one whose pieces were all dropped keeps
-- waiting until a person unsplits it.
CREATE FUNCTION settle_umbrella(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  u todos%ROWTYPE;
  pieces int;
  open_pieces int;
  target uuid;
  archives boolean;
  saved_kind text := current_setting('telos.actor_kind', true);
  saved_key text := current_setting('telos.actor_key_id', true);
  saved_run text := current_setting('telos.run_id', true);
  saved_note text := current_setting('telos.note_id', true);
  saved_reason text := current_setting('telos.reason', true);
  saved_settling text := current_setting('telos.settling', true);
BEGIN
  IF p_id IS NULL THEN
    RETURN;
  END IF;
  -- Locked, so two pieces finishing at once in two transactions cannot each
  -- see the other still open and both leave the umbrella waiting.
  SELECT * INTO u FROM todos WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR u.split_at IS NULL OR u.archived_at IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE completed_at IS NULL) INTO pieces, open_pieces
  FROM todos WHERE parent_id = p_id AND (archived_at IS NULL OR completed_at IS NOT NULL);
  IF pieces = 0 OR (open_pieces = 0) = (u.completed_at IS NOT NULL) THEN
    RETURN;
  END IF;

  PERFORM set_config('telos.actor_kind', 'system', true);
  PERFORM set_config('telos.actor_key_id', '', true);
  PERFORM set_config('telos.run_id', '', true);
  PERFORM set_config('telos.note_id', '', true);
  PERFORM set_config('telos.reason', '', true);
  PERFORM set_config('telos.settling', 'on', true);

  IF open_pieces = 0 THEN
    SELECT id INTO target FROM lanes WHERE project_id = u.project_id AND is_done LIMIT 1;
    SELECT archive_on_success INTO archives FROM lanes WHERE id = u.lane_id;
    UPDATE todos SET
      completed_at = now(),
      archived_at = CASE WHEN coalesce(archives, false) THEN now() END,
      lane_id = coalesce(target, lane_id),
      position = CASE
        WHEN target IS NULL THEN position
        ELSE (SELECT coalesce(max(t.position) + 1, 0) FROM todos t WHERE t.project_id = u.project_id)
      END,
      updated_at = now()
    WHERE id = p_id;
  ELSE
    SELECT id INTO target FROM lanes WHERE project_id = u.project_id AND NOT is_done
    ORDER BY position, created_at LIMIT 1;
    UPDATE todos SET completed_at = NULL, lane_id = target, updated_at = now()
    WHERE id = p_id;
  END IF;

  PERFORM set_config('telos.actor_kind', coalesce(saved_kind, ''), true);
  PERFORM set_config('telos.actor_key_id', coalesce(saved_key, ''), true);
  PERFORM set_config('telos.run_id', coalesce(saved_run, ''), true);
  PERFORM set_config('telos.note_id', coalesce(saved_note, ''), true);
  PERFORM set_config('telos.reason', coalesce(saved_reason, ''), true);
  PERFORM set_config('telos.settling', coalesce(saved_settling, ''), true);
END;
$$;
--> statement-breakpoint

-- A piece completed, reopened, archived, restored, added or moved to another
-- parent settles the umbrellas it left and joined. Settling an umbrella that
-- is itself a piece settles its own umbrella in turn.
CREATE FUNCTION settle_umbrellas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM settle_umbrella(OLD.parent_id);
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
    PERFORM settle_umbrella(NEW.parent_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER todos_settle_umbrella AFTER INSERT OR DELETE ON todos
  FOR EACH ROW EXECUTE FUNCTION settle_umbrellas();
--> statement-breakpoint
CREATE TRIGGER todos_settle_umbrella_update AFTER UPDATE OF completed_at, archived_at, parent_id ON todos
  FOR EACH ROW WHEN (
    (OLD.completed_at IS NULL, OLD.archived_at IS NULL, OLD.parent_id)
      IS DISTINCT FROM (NEW.completed_at IS NULL, NEW.archived_at IS NULL, NEW.parent_id)
  )
  EXECUTE FUNCTION settle_umbrellas();
--> statement-breakpoint

-- Those whose pieces are all done close now, as they would have had the
-- trigger been there.
SELECT settle_umbrella(id) FROM todos WHERE split_at IS NOT NULL;
