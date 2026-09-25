ALTER TABLE "todos" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_todos_archived_at" ON "todos" ("archived_at");
--> statement-breakpoint
-- Archiving and restoring are events of their own, and outrank everything but
-- a create when a transaction folds several changes into one.
CREATE OR REPLACE FUNCTION record_todo_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_kind text;
  changed text[] := '{}';
  earlier todo_events%ROWTYPE;
BEGIN
  IF pg_trigger_depth() > 1 THEN
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
$$;
