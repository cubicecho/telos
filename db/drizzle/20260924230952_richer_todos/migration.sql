CREATE TABLE "todo_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"todo_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_lane_id" uuid,
	"to_lane_id" uuid,
	"fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_key_id" uuid,
	"run_id" uuid,
	"note_id" uuid,
	"reason" text,
	"at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todo_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"todo_id" uuid NOT NULL,
	"kind" text DEFAULT 'note' NOT NULL,
	"body" text NOT NULL,
	"actor_kind" text DEFAULT 'user' NOT NULL,
	"actor_key_id" uuid,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ai_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "acceptance" text;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "ai_ignored" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_todo_events_user_id" ON "todo_events" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_todo_events_todo_id" ON "todo_events" ("todo_id","at");--> statement-breakpoint
CREATE INDEX "idx_todo_notes_user_id" ON "todo_notes" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_todo_notes_todo_id" ON "todo_notes" ("todo_id");--> statement-breakpoint
CREATE INDEX "idx_todos_parent_id" ON "todos" ("parent_id");--> statement-breakpoint
ALTER TABLE "todo_events" ADD CONSTRAINT "todo_events_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todo_events" ADD CONSTRAINT "todo_events_todo_id_todos_id_fkey" FOREIGN KEY ("todo_id") REFERENCES "todos"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todo_events" ADD CONSTRAINT "todo_events_note_id_todo_notes_id_fkey" FOREIGN KEY ("note_id") REFERENCES "todo_notes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "todo_notes" ADD CONSTRAINT "todo_notes_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todo_notes" ADD CONSTRAINT "todo_notes_todo_id_todos_id_fkey" FOREIGN KEY ("todo_id") REFERENCES "todos"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_parent_id_todos_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "todos"("id") ON DELETE SET NULL;--> statement-breakpoint
-- A todo's history, written here rather than by each resolver so that no path
-- that changes a todo can forget to. Who did it comes from settings the server
-- puts on the transaction (server/src/provenance.ts); a write that set none is
-- recorded as 'system'. Cascaded changes (a parent or a project being deleted)
-- are skipped: they run mid-delete, and the rows they would describe are
-- usually on their way out too.
--
-- One event per todo per transaction. A request often touches a todo twice —
-- a generated create inserts it and then realignLanes gives it a lane — and
-- the history should read as what the request did, not how. A second change
-- folds into the event the transaction already wrote (found by its xmin),
-- keeping the strongest kind: create, then complete/reopen, then move, then
-- edit.
CREATE FUNCTION record_todo_event() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL THEN
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
--> statement-breakpoint
CREATE TRIGGER todos_history AFTER INSERT OR UPDATE ON todos FOR EACH ROW EXECUTE FUNCTION record_todo_event();
