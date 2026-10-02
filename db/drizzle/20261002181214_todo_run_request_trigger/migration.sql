-- A run request is for the todo where it stands. Moved, done, archived or
-- ignored, it no longer waits on one, whichever write got it there.
CREATE FUNCTION drop_stale_run_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_requested_at IS NOT NULL AND (
    NEW.lane_id IS DISTINCT FROM OLD.lane_id
    OR NEW.completed_at IS NOT NULL
    OR NEW.archived_at IS NOT NULL
    OR NEW.ai_ignored
  ) THEN
    NEW.run_requested_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER todos_run_request BEFORE UPDATE ON todos FOR EACH ROW EXECUTE FUNCTION drop_stale_run_request();
