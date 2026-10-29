-- Projects that ran by themselves keep doing so; the rest wait to be asked, a
-- lane at a time, as they did.
UPDATE "projects" SET "run_mode" = 'auto' WHERE "auto_run";
--> statement-breakpoint
-- A followed todo keeps its mark across lanes, so the trigger that drops a
-- stale run request leaves it alone when the todo moves, and drops it only
-- when the todo is done, archived or ignored.
CREATE OR REPLACE FUNCTION drop_stale_run_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_requested_at IS NOT NULL AND (
    NEW.lane_id IS DISTINCT FROM OLD.lane_id
    OR NEW.completed_at IS NOT NULL
    OR NEW.archived_at IS NOT NULL
    OR NEW.ai_ignored
  ) THEN
    NEW.run_requested_at := NULL;
  END IF;
  IF NEW.followed_at IS NOT NULL AND (
    NEW.completed_at IS NOT NULL
    OR NEW.archived_at IS NOT NULL
    OR NEW.ai_ignored
  ) THEN
    NEW.followed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
