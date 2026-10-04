-- Lane presets go, and with them the triggers that kept lanes in step with
-- them. Written by hand: drizzle-kit does not know about triggers. No data is
-- carried over: a lane's contract, prompt and preset are dropped, not folded
-- into its agent.
DROP TRIGGER "lanes_follow_preset" ON "lanes";--> statement-breakpoint
DROP TRIGGER "lane_presets_reach_lanes" ON "lane_presets";--> statement-breakpoint
DROP TRIGGER "lane_presets_copy_before_delete" ON "lane_presets";--> statement-breakpoint
DROP FUNCTION "follow_lane_preset"();--> statement-breakpoint
DROP FUNCTION "carry_lane_preset_to_lanes"();--> statement-breakpoint
DROP FUNCTION "copy_lane_preset_before_delete"();--> statement-breakpoint
ALTER TABLE "lanes" DROP CONSTRAINT "lanes_preset_id_lane_presets_id_fkey";--> statement-breakpoint
DROP TABLE "lane_presets";--> statement-breakpoint
ALTER TABLE "lanes" DROP CONSTRAINT "ck_lanes_contract";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "ck_runs_contract";--> statement-breakpoint
DROP INDEX "idx_lanes_preset_id";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "new_todo_lane_id" uuid;--> statement-breakpoint
ALTER TABLE "lanes" DROP COLUMN "contract";--> statement-breakpoint
ALTER TABLE "lanes" DROP COLUMN "prompt";--> statement-breakpoint
ALTER TABLE "lanes" DROP COLUMN "preset_id";--> statement-breakpoint
ALTER TABLE "lanes" DROP COLUMN "preset_overrides";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "ck_runs_owner", ADD CONSTRAINT "ck_runs_owner" CHECK (("kind" = 'todo' and "todo_id" is not null and "draft_id" is null)
        or ("kind" = 'draft' and "draft_id" is not null and "todo_id" is null));--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "contract";--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_new_todo_lane_id_lanes_id_fkey" FOREIGN KEY ("new_todo_lane_id") REFERENCES "lanes"("id") ON DELETE SET NULL;
