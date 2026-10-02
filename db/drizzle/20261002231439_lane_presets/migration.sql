CREATE TABLE "lane_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contract" text DEFAULT 'work' NOT NULL,
	"prompt" text,
	"wip_limit" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_lane_presets_user_name" UNIQUE("user_id","name"),
	CONSTRAINT "ck_lane_presets_contract" CHECK ("contract" in ('work', 'verdict', 'expand')),
	CONSTRAINT "ck_lane_presets_wip_limit" CHECK ("wip_limit" > 0),
	CONSTRAINT "ck_lane_presets_max_attempts" CHECK ("max_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "lanes" ADD COLUMN "preset_id" uuid;--> statement-breakpoint
ALTER TABLE "lanes" ADD COLUMN "preset_overrides" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_lane_presets_user_id" ON "lane_presets" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_lanes_preset_id" ON "lanes" ("preset_id");--> statement-breakpoint
ALTER TABLE "lane_presets" ADD CONSTRAINT "lane_presets_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_preset_id_lane_presets_id_fkey" FOREIGN KEY ("preset_id") REFERENCES "lane_presets"("id") ON DELETE SET NULL;--> statement-breakpoint
-- A lane that follows a preset holds the preset's contract, WIP limit and
-- attempts, except for the fields `preset_overrides` names as the lane's own.
-- Kept so here rather than read through a join, so everything that reads a lane
-- (the queue, the board, a claim) reads what a run is to go by, as it always
-- has. The prompt is not copied: a lane's prompt is what it adds after its
-- preset's (server/src/resolvers/runs.ts joins them for a run).
--
-- A write that changes one of those fields on a lane already following a
-- preset, and says nothing about `preset_overrides`, is the lane taking its own
-- value: the field is added to the list rather than quietly put back.
CREATE FUNCTION follow_lane_preset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  preset lane_presets%ROWTYPE;
BEGIN
  IF NEW.preset_id IS NULL THEN
    NEW.preset_overrides := '[]'::jsonb;
    RETURN NEW;
  END IF;
  SELECT * INTO preset FROM lane_presets WHERE id = NEW.preset_id AND user_id = NEW.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lane % cannot follow preset %: it is not a preset of the lane''s account', NEW.id, NEW.preset_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.preset_id IS NOT DISTINCT FROM OLD.preset_id
    AND NEW.preset_overrides = OLD.preset_overrides THEN
    IF NEW.contract IS DISTINCT FROM OLD.contract AND NOT NEW.preset_overrides @> '["contract"]'::jsonb THEN
      NEW.preset_overrides := NEW.preset_overrides || '["contract"]'::jsonb;
    END IF;
    IF NEW.wip_limit IS DISTINCT FROM OLD.wip_limit AND NOT NEW.preset_overrides @> '["wipLimit"]'::jsonb THEN
      NEW.preset_overrides := NEW.preset_overrides || '["wipLimit"]'::jsonb;
    END IF;
    IF NEW.max_attempts IS DISTINCT FROM OLD.max_attempts AND NOT NEW.preset_overrides @> '["maxAttempts"]'::jsonb THEN
      NEW.preset_overrides := NEW.preset_overrides || '["maxAttempts"]'::jsonb;
    END IF;
  END IF;
  IF NOT NEW.preset_overrides @> '["contract"]'::jsonb THEN
    NEW.contract := preset.contract;
  END IF;
  IF NOT NEW.preset_overrides @> '["wipLimit"]'::jsonb THEN
    NEW.wip_limit := preset.wip_limit;
  END IF;
  IF NOT NEW.preset_overrides @> '["maxAttempts"]'::jsonb THEN
    NEW.max_attempts := preset.max_attempts;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lanes_follow_preset BEFORE INSERT OR UPDATE ON lanes
  FOR EACH ROW EXECUTE FUNCTION follow_lane_preset();
--> statement-breakpoint
-- Editing a preset edits every lane that follows it: touching them is enough,
-- since `lanes_follow_preset` then reads the preset again. The prompt is in the
-- list so a board watching a lane hears that what it will be told changed.
CREATE FUNCTION carry_lane_preset_to_lanes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE lanes SET updated_at = now() WHERE preset_id = NEW.id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lane_presets_reach_lanes AFTER UPDATE OF contract, prompt, wip_limit, max_attempts ON lane_presets
  FOR EACH ROW EXECUTE FUNCTION carry_lane_preset_to_lanes();
--> statement-breakpoint
-- Deleting a preset leaves what followed it as it was, with the preset's values
-- copied in: its lanes keep the contract and limits they already hold and gain
-- its prompt ahead of their own, and the board templates that named it get the
-- same, so applying one later builds the lanes it would have built.
CREATE FUNCTION copy_lane_preset_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE lanes SET
    prompt = nullif(concat_ws(E'\n\n', nullif(btrim(OLD.prompt), ''), nullif(btrim(prompt), '')), ''),
    preset_id = NULL,
    updated_at = now()
  WHERE preset_id = OLD.id;

  UPDATE board_templates bt SET
    lanes = (
      SELECT jsonb_agg(
        CASE WHEN e.lane ->> 'presetId' = OLD.id::text THEN
          (e.lane - 'presetId' - 'presetOverrides') || jsonb_build_object(
            'prompt',
            nullif(concat_ws(E'\n\n', nullif(btrim(OLD.prompt), ''), nullif(btrim(e.lane ->> 'prompt'), '')), ''),
            'contract',
            CASE WHEN coalesce(e.lane -> 'presetOverrides', '[]'::jsonb) @> '["contract"]'::jsonb
              THEN e.lane -> 'contract' ELSE to_jsonb(OLD.contract) END,
            'wipLimit',
            CASE WHEN coalesce(e.lane -> 'presetOverrides', '[]'::jsonb) @> '["wipLimit"]'::jsonb
              THEN e.lane -> 'wipLimit' ELSE to_jsonb(OLD.wip_limit) END,
            'maxAttempts',
            CASE WHEN coalesce(e.lane -> 'presetOverrides', '[]'::jsonb) @> '["maxAttempts"]'::jsonb
              THEN e.lane -> 'maxAttempts' ELSE to_jsonb(OLD.max_attempts) END
          )
        ELSE e.lane END
        ORDER BY e.at
      )
      FROM jsonb_array_elements(bt.lanes) WITH ORDINALITY AS e(lane, at)
    ),
    updated_at = now()
  WHERE bt.user_id = OLD.user_id
    AND bt.lanes @> jsonb_build_array(jsonb_build_object('presetId', OLD.id::text));

  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lane_presets_copy_before_delete BEFORE DELETE ON lane_presets
  FOR EACH ROW EXECUTE FUNCTION copy_lane_preset_before_delete();
